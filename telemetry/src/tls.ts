// Verified TLS to a free Tiger service, by pinning.
//
// Free Tiger services do not present a certificate from a public CA. The service presents a leaf for its own
// host name, issued by Timescale's private CA ("O=Timescale Inc, CN=ca.timescale.com"). That CA certificate was
// fetched once with `openssl s_client -starttls postgres` and is stored in certs/tiger-ca.crt (a public
// certificate, not a secret; .crt because the repo ignores *.pem). Every connection then requires:
//   1. a chain that ends at that pinned certificate (Node's own verification, rejectUnauthorized on), and
//   2. a host check: the leaf must name the pinned host (tls.checkServerIdentity), and the host we dial must be
//      the pinned host.
// With TIGER_PIN_LEAF=1 the exact leaf (by SHA-256) is required as well. There is no unverified fallback: if the
// pin cannot be loaded or does not match, the connection fails with a message that says how to refresh it.
import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import tls, { type ConnectionOptions, type PeerCertificate } from 'node:tls';

import type { PgTarget } from './credentials.js';

export const DEFAULT_CERT_DIR = new URL('../certs/', import.meta.url);

export interface PinFile {
    serviceId: string;
    host: string;
    port: number;
    caFile: string;
    caSubject: string;
    caSha256: string;
    caNotAfter: string;
    leafSubject: string;
    leafSha256: string;
    leafNotBefore: string;
    leafNotAfter: string;
    fetchedAt: string;
    fetchedWith: string;
    /** How the pin was checked against something other than the network it was fetched over. */
    corroboration?: string;
}

export interface LoadedPin {
    readonly pin: PinFile;
    readonly caPem: string;
}

export class TlsPinError extends Error {
    override readonly name = 'TlsPinError';
}

const REFRESH = 'See telemetry/README.md, "Refreshing the pinned certificate" (npm run cert:check, then npm run cert:refresh).';

function normalizeFingerprint(value: string): string {
    return value.replace(/[^0-9a-f]/gi, '').toUpperCase();
}

/** Reads certs/tiger-pin.json and the CA it names, and checks the file on disk is the certificate that was pinned. */
export function loadPin(dir: URL = DEFAULT_CERT_DIR, now: Date = new Date()): LoadedPin {
    let pin: PinFile;
    let caPem: string;
    try {
        pin = JSON.parse(readFileSync(new URL('tiger-pin.json', dir), 'utf8')) as PinFile;
        caPem = readFileSync(new URL(pin.caFile, dir), 'utf8');
    } catch (error) {
        throw new TlsPinError(`The pinned Tiger certificate could not be read (${(error as Error).message}). ${REFRESH}`);
    }
    let ca: X509Certificate;
    try {
        ca = new X509Certificate(caPem);
    } catch {
        throw new TlsPinError(`certs/${pin.caFile} is not a PEM certificate. ${REFRESH}`);
    }
    if (normalizeFingerprint(ca.fingerprint256) !== normalizeFingerprint(pin.caSha256)) {
        throw new TlsPinError(`certs/${pin.caFile} does not match the SHA-256 recorded in certs/tiger-pin.json. ${REFRESH}`);
    }
    if (new Date(ca.validTo).getTime() <= now.getTime()) {
        throw new TlsPinError(`The pinned Tiger CA certificate expired on ${ca.validTo}. ${REFRESH}`);
    }
    return { pin, caPem };
}

export interface PinnedSslOptions {
    /** Require the exact leaf certificate too (TIGER_PIN_LEAF=1). */
    pinLeaf?: boolean;
    /** Called once per handshake with the leaf's SHA-256 and whether it still equals the recorded one. */
    onLeaf?: (leafSha256: string, matchesRecorded: boolean) => void;
}

/**
 * The `ssl` option for pg: verification against the pinned certificate plus a host check. Throws if the target is
 * not the pinned host, so a different service can never be reached with this trust anchor by accident.
 */
export function pinnedSsl(target: Pick<PgTarget, 'host' | 'port'>, loaded: LoadedPin, options: PinnedSslOptions = {}): ConnectionOptions {
    const { pin, caPem } = loaded;
    if (target.host.toLowerCase() !== pin.host.toLowerCase()) {
        throw new TlsPinError(`The pinned certificate is for ${pin.host}, but the connection string points at ${target.host}. ${REFRESH}`);
    }
    if (target.port !== pin.port) {
        throw new TlsPinError(`The pinned certificate was fetched from port ${pin.port}, but the connection string uses port ${target.port}. ${REFRESH}`);
    }
    const recordedLeaf = normalizeFingerprint(pin.leafSha256);
    return {
        ca: [caPem],
        rejectUnauthorized: true,
        servername: pin.host,
        minVersion: 'TLSv1.2',
        checkServerIdentity(hostname: string, cert: PeerCertificate): Error | undefined {
            if (hostname.toLowerCase() !== pin.host.toLowerCase()) {
                return new TlsPinError(`TLS host check failed: dialled ${hostname}, pinned ${pin.host}.`);
            }
            const hostError = tls.checkServerIdentity(hostname, cert);
            if (hostError) return new TlsPinError(`TLS host check failed: ${hostError.message}`);
            const leaf = normalizeFingerprint(cert.fingerprint256 ?? '');
            const matches = leaf.length > 0 && leaf === recordedLeaf;
            options.onLeaf?.(leaf, matches);
            if (options.pinLeaf && !matches) {
                return new TlsPinError(`The Tiger server's certificate is not the pinned leaf (TIGER_PIN_LEAF=1). ${REFRESH}`);
            }
            return undefined;
        },
    };
}
