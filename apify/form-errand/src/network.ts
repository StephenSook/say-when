import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import type { BrowserContext, Page } from 'playwright';

/** Loopback, private, link-local, carrier-grade NAT, unspecified and multicast addresses. */
export function isPrivateAddress(address: string): boolean {
    const ip = address.replace(/^\[|\]$/g, '').toLowerCase();
    if (isIP(ip) === 4) {
        const [a, b] = ip.split('.').map(Number);
        return (
            a === 0 ||
            a === 10 ||
            a === 127 ||
            (a === 100 && b >= 64 && b <= 127) ||
            (a === 169 && b === 254) ||
            (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && b === 168) ||
            (a === 198 && (b === 18 || b === 19)) ||
            a >= 224
        );
    }
    if (isIP(ip) === 6) {
        if (ip === '::' || ip === '::1') return true;
        if (ip.startsWith('::ffff:')) {
            const mapped = ip.slice(7);
            return isIP(mapped) === 4 ? isPrivateAddress(mapped) : true;
        }
        return /^(fc|fd|fe[89ab]|ff)/.test(ip);
    }
    return false;
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
 * Blocks requests to private addresses before they leave the browser, and records every request
 * (including redirect hops, which route handlers do not see) so a page that reached one is refused.
 */
export class NetworkGuard {
    private violated = false;
    private readonly hosts = new Set<string>();

    constructor(private readonly policy: HostPolicy) {}

    async attach(context: BrowserContext): Promise<void> {
        await context.route('**/*', async (route) => {
            if (await this.policy.allowed(route.request().url())) await route.continue();
            else await route.abort('blockedbyclient');
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

    /** True when every request and every frame so far stayed on public hosts. */
    async clean(page: Page): Promise<boolean> {
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
