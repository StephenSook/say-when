import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import ipaddr from 'ipaddr.js';
import type { BrowserContext, Page } from 'playwright';

/**
 * True for anything that is not a global unicast address: private, loopback, link-local, carrier-grade NAT,
 * multicast, reserved, and the IPv6 forms that embed an IPv4 address (6to4, NAT64, Teredo). IPv4-mapped IPv6
 * is unwrapped first. Anything that does not parse counts as private.
 */
export function isPrivateAddress(address: string): boolean {
    const ip = address.replace(/^\[|\]$/g, '');
    if (!ipaddr.isValid(ip)) return true;
    try {
        return ipaddr.process(ip).range() !== 'unicast';
    } catch {
        return true;
    }
}

const LOCAL_NAMES = new Set(['localhost', '127.0.0.1', '::1']);
const INLINE_SCHEMES = new Set(['data:', 'blob:', 'about:']);

type Resolver = (host: string) => Promise<Array<{ address: string }>>;

/**
 * Decides which URLs the browser may reach: public http(s) hosts only, so a form URL or a redirect
 * cannot be used to read a private network address and return it in a screenshot.
 */
export class HostPolicy {
    private readonly cache = new Map<string, Promise<boolean>>();

    constructor(
        private readonly allowLocal: boolean,
        private readonly resolve: Resolver = (host) => lookup(host, { all: true }),
    ) {}

    /** For the address a response actually came from. Loopback passes only in tests and the demo. */
    addressAllowed(address: string): boolean {
        const ip = address.replace(/^\[|\]$/g, '');
        if (this.allowLocal && (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1')) return true;
        return !isPrivateAddress(ip);
    }

    /** The checks that need no DNS: scheme, local names and IP literals. */
    syncAllowed(rawUrl: string): boolean {
        let url: URL;
        try {
            url = new URL(rawUrl);
        } catch {
            return false;
        }
        if (INLINE_SCHEMES.has(url.protocol)) return true;
        if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
        const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
        if (this.allowLocal && LOCAL_NAMES.has(host)) return true;
        if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) return false;
        if (isIP(host)) return !isPrivateAddress(host);
        return true;
    }

    /** Full check: also resolves the host name and requires every address to be public. */
    async allowed(rawUrl: string): Promise<boolean> {
        if (!this.syncAllowed(rawUrl)) return false;
        const url = new URL(rawUrl);
        if (INLINE_SCHEMES.has(url.protocol)) return true;
        const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
        if (isIP(host) || (this.allowLocal && LOCAL_NAMES.has(host))) return true;
        let verdict = this.cache.get(host);
        if (!verdict) {
            verdict = this.resolve(host)
                .then((addresses) => addresses.length > 0 && addresses.every((a) => !isPrivateAddress(a.address)))
                .catch(() => false);
            this.cache.set(host, verdict);
        }
        return verdict;
    }
}

/**
 * Blocks requests to private addresses before they leave the browser, records every request (including
 * redirect hops, which route handlers do not see), blocks WebSockets, and checks the address each response
 * actually came from, so a DNS answer that changes between our check and the browser's own lookup is still
 * caught. A page that reached a private address is refused and never screenshotted.
 */
export class NetworkGuard {
    private violated = false;
    private readonly hosts = new Set<string>();
    private readonly addressChecks: Array<Promise<void>> = [];
    private frozen = false;

    constructor(private readonly policy: HostPolicy) {}

    /** While frozen, every new request is aborted, so nothing can load between a check and a screenshot. */
    freeze(): void {
        this.frozen = true;
    }

    thaw(): void {
        this.frozen = false;
    }

    async attach(context: BrowserContext): Promise<void> {
        await context.route('**/*', async (route) => {
            if (!this.frozen && (await this.policy.allowed(route.request().url()))) await route.continue();
            else await route.abort('blockedbyclient');
        });
        // Forms do not need WebSockets, and page.route does not see them.
        await context.routeWebSocket(/.*/, async (ws) => {
            this.violated = this.violated || !this.policy.syncAllowed(ws.url());
            await ws.close({ code: 1008, reason: 'blocked' });
        });
        context.on('response', (response) => {
            this.addressChecks.push(
                response
                    .serverAddr()
                    .then((server) => {
                        if (server && !this.policy.addressAllowed(server.ipAddress)) this.violated = true;
                    })
                    .catch(() => undefined),
            );
        });
        context.on('request', (request) => {
            const url = request.url();
            if (!this.policy.syncAllowed(url)) {
                this.violated = true;
                return;
            }
            try {
                const { protocol, hostname } = new URL(url);
                if (protocol === 'https:' || protocol === 'http:') this.hosts.add(`${protocol}//${hostname}/`);
            } catch {
                this.violated = true;
            }
        });
    }

    /** True when every request, response address and frame so far stayed on public hosts. */
    async clean(page: Page): Promise<boolean> {
        await Promise.all(this.addressChecks.splice(0));
        if (this.violated) return false;
        for (const frame of page.frames()) {
            const url = frame.url();
            if (url && url !== 'about:blank' && !(await this.policy.allowed(url))) return false;
        }
        for (const origin of this.hosts) {
            if (!(await this.policy.allowed(origin))) return false;
        }
        return true;
    }
}
