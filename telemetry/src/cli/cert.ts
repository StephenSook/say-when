// npm run cert:check    fetch the service's certificate chain and compare it with certs/tiger-pin.json (read only)
// npm run cert:refresh  the same, then print what a new pin would be; add `-- --write` to save it
//
// The chain is fetched with `openssl s_client -starttls postgres`, the way Tiger's strict-SSL page describes. A
// certificate fetched over a network proves nothing about who sent it, so refresh also checks the leaf against the
// presented CA and the host name, and compares the leaf's start date with the service's creation time from the
// Tiger API (which is reached over CA-verified HTTPS). Read the output before writing a new pin.
import { execFile, spawn } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { writeFileSync } from 'node:fs';

import { DEFAULT_CERT_DIR, loadPin, type PinFile } from '../tls.js';

const mode = process.argv[2];
const write = process.argv.includes('--write');
if (mode !== 'check' && mode !== 'refresh') {
    console.error('usage: tsx src/cli/cert.ts check|refresh [--write]');
    process.exit(2);
}

function fetchChain(host: string, port: number): Promise<string[]> {
    return new Promise((resolve, reject) => {
        const child = spawn(process.env.OPENSSL ?? 'openssl', ['s_client', '-starttls', 'postgres', '-connect', `${host}:${port}`, '-servername', host, '-showcerts'], {
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        let out = '';
        child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
        child.on('error', reject);
        const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
        child.on('close', () => {
            clearTimeout(timer);
            const pems = out.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
            if (pems.length === 0) reject(new Error('openssl printed no certificate (is the service running, and is this an OpenSSL with -starttls postgres?)'));
            else resolve(pems.map((p) => `${p}\n`));
        });
        child.stdin.end();
    });
}

function serviceCreated(serviceId: string): Promise<string | null> {
    return new Promise((resolve) => {
        execFile(process.env.TIGER_CLI ?? 'tiger', ['service', 'get', serviceId, '-o', 'json', '--skip-update-check'], { timeout: 20_000 }, (error, stdout) => {
            if (error) return resolve(null);
            try {
                const created = (JSON.parse(String(stdout)) as { created?: unknown }).created;
                resolve(typeof created === 'string' ? created : null);
            } catch {
                resolve(null);
            }
        });
    });
}

const { pin } = loadPin();
const chain = (await fetchChain(pin.host, pin.port)).map((pem) => ({ pem, cert: new X509Certificate(pem) }));
const leaf = chain[0]!;
const ca = chain.find((c, i) => i > 0 && leaf.cert.checkIssued(c.cert));
const hostOk = leaf.cert.checkHost(pin.host) !== undefined;
const signedOk = !!ca && leaf.cert.verify(ca.cert.publicKey);

console.log(`host: ${pin.host}:${pin.port}`);
console.log(`leaf: ${leaf.cert.subject.replace(/\n/g, ', ')}  sha256 ${leaf.cert.fingerprint256}  valid ${leaf.cert.validFrom} to ${leaf.cert.validTo}`);
console.log(`ca:   ${ca ? `${ca.cert.subject.replace(/\n/g, ', ')}  sha256 ${ca.cert.fingerprint256}  valid ${ca.cert.validFrom} to ${ca.cert.validTo}` : 'not presented'}`);
console.log(`leaf names the host: ${hostOk}; leaf signed by the presented CA: ${signedOk}`);
console.log(`pinned CA matches: ${ca?.cert.fingerprint256 === pin.caSha256}; recorded leaf matches: ${leaf.cert.fingerprint256 === pin.leafSha256}`);

if (mode === 'check') {
    process.exitCode = ca?.cert.fingerprint256 === pin.caSha256 && hostOk && signedOk ? 0 : 1;
} else {
    const created = await serviceCreated(pin.serviceId);
    const notBefore = new Date(leaf.cert.validFrom);
    console.log(`service created (Tiger API): ${created ?? 'unavailable'}; leaf not before: ${notBefore.toISOString()}`);
    if (!ca || !hostOk || !signedOk) {
        console.error('refusing: the presented chain does not verify for this host.');
        process.exitCode = 1;
    } else if (!write) {
        console.log('dry run. Compare the fingerprints above with a second network if you can, then run again with -- --write.');
    } else {
        const next: PinFile = {
            ...pin,
            caSubject: ca.cert.subject.replace(/\n/g, ', '),
            caSha256: ca.cert.fingerprint256,
            caNotAfter: new Date(ca.cert.validTo).toISOString().replace('.000Z', 'Z'),
            leafSubject: leaf.cert.subject.replace(/\n/g, ', '),
            leafSha256: leaf.cert.fingerprint256,
            leafNotBefore: notBefore.toISOString().replace('.000Z', 'Z'),
            leafNotAfter: new Date(leaf.cert.validTo).toISOString().replace('.000Z', 'Z'),
            fetchedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
            fetchedWith: 'openssl s_client -starttls postgres -showcerts (npm run cert:refresh)',
            corroboration: created
                ? `Leaf notBefore ${notBefore.toISOString()}; service created ${created} per the Tiger API over CA-verified HTTPS.`
                : 'The Tiger API was not reachable at refresh time; nothing corroborates this certificate.',
        };
        writeFileSync(new URL(pin.caFile, DEFAULT_CERT_DIR), ca.pem);
        writeFileSync(new URL('tiger-pin.json', DEFAULT_CERT_DIR), `${JSON.stringify(next, null, 4)}\n`);
        console.log('wrote certs/tiger-ca.crt and certs/tiger-pin.json. Review the diff before committing.');
    }
}
