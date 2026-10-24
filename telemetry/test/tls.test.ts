// The pinning, end to end through the real pg client, against a local server that speaks the start of the
// Postgres protocol (SSLRequest, then TLS, then an error reply). Throwaway certificates are made with openssl at
// test time in a temporary folder and deleted afterwards; no key is ever written into the repo.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import tls from 'node:tls';
import pg from 'pg';

import { poolConfig } from '../src/db.js';
import { loadPin, pinnedSsl, TlsPinError, type LoadedPin, type PinFile } from '../src/tls.js';

const dir = mkdtempSync(join(tmpdir(), 'telemetry-tls-'));
const file = (name: string) => join(dir, name);

function openssl(args: string[]): void {
    try {
        execFileSync(process.env.OPENSSL ?? 'openssl', args, { cwd: dir, stdio: 'pipe' });
    } catch (error) {
        throw new Error(`openssl is needed for the TLS tests and failed: ${(error as Error).message.split('\n')[0]}`);
    }
}

function makeCa(name: string): void {
    openssl(['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', `${name}.key`, '-out', `${name}.crt`, '-days', '2', '-subj', `/CN=${name}`,
        '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
}

function makeLeaf(name: string, ca: string, dns: string): void {
    writeFileSync(file(`${name}.ext`), `subjectAltName=DNS:${dns}\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature\nextendedKeyUsage=serverAuth\n`);
    openssl(['req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', `${name}.key`, '-out', `${name}.csr`, '-subj', `/CN=${dns}`]);
    openssl(['x509', '-req', '-in', `${name}.csr`, '-CA', `${ca}.crt`, '-CAkey', `${ca}.key`, '-CAcreateserial', '-out', `${name}.crt`, '-days', '2', '-extfile', `${name}.ext`]);
}

const read = (name: string) => readFileSync(file(name), 'utf8');

/** A server that answers the SSLRequest with 'S', completes TLS with the given leaf, then refuses the login. */
async function fakePostgres(leaf: string, ca: string): Promise<{ port: number; handshakes: () => number; close: () => Promise<void> }> {
    let handshakes = 0;
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
        sockets.add(socket);
        socket.once('data', () => {
            socket.write('S');
            const secure = new tls.TLSSocket(socket, { isServer: true, key: read(`${leaf}.key`), cert: read(`${leaf}.crt`) + read(`${ca}.crt`) });
            secure.on('error', () => socket.destroy());
            secure.on('secure', () => {
                handshakes++;
                secure.once('data', () => {
                    const fields = 'SFATAL\0C28000\0Mtls ok, test server\0\0';
                    const body = Buffer.from(fields, 'utf8');
                    const head = Buffer.alloc(5);
                    head.write('E', 0);
                    head.writeInt32BE(body.length + 4, 1);
                    secure.end(Buffer.concat([head, body]));
                });
            });
        });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as net.AddressInfo).port;
    return {
        port,
        handshakes: () => handshakes,
        close: () =>
            new Promise((r) => {
                for (const s of sockets) s.destroy();
                server.close(() => r());
            }),
    };
}

function pinFor(port: number, ca: string, leaf: string): LoadedPin {
    const caCert = new X509Certificate(read(`${ca}.crt`));
    const leafCert = new X509Certificate(read(`${leaf}.crt`));
    const pin: PinFile = {
        serviceId: 'test',
        host: 'localhost',
        port,
        caFile: `${ca}.crt`,
        caSubject: caCert.subject,
        caSha256: caCert.fingerprint256,
        caNotAfter: caCert.validTo,
        leafSubject: leafCert.subject,
        leafSha256: leafCert.fingerprint256,
        leafNotBefore: leafCert.validFrom,
        leafNotAfter: leafCert.validTo,
        fetchedAt: new Date().toISOString(),
        fetchedWith: 'test',
    };
    return { pin, caPem: read(`${ca}.crt`) };
}

async function tryConnect(port: number, loaded: LoadedPin, pinLeaf = false): Promise<string> {
    const target = { host: 'localhost', port, user: 'u', password: 'not-a-real-password', database: 'd', options: null };
    const client = new pg.Client(poolConfig(target, pinnedSsl(target, loaded, { pinLeaf }), { statementTimeoutMs: 2_000 }));
    try {
        await client.connect();
        return 'connected';
    } catch (error) {
        return (error as Error).message;
    } finally {
        await client.end().catch(() => {});
    }
}

before(() => {
    makeCa('good-ca');
    makeCa('rogue-ca');
    makeLeaf('good-leaf', 'good-ca', 'localhost');
    makeLeaf('rogue-leaf', 'rogue-ca', 'localhost');
    makeLeaf('wrong-host', 'good-ca', 'other.test');
    makeLeaf('second-leaf', 'good-ca', 'localhost');
});

after(() => rmSync(dir, { recursive: true, force: true }));

describe('pinned TLS through the pg client', () => {
    test('the pinned CA and the right host: TLS completes and the server answers', async () => {
        const server = await fakePostgres('good-leaf', 'good-ca');
        try {
            const result = await tryConnect(server.port, pinFor(server.port, 'good-ca', 'good-leaf'));
            assert.match(result, /tls ok, test server/);
            assert.equal(server.handshakes(), 1);
        } finally {
            await server.close();
        }
    });

    test('a chain from another CA is refused before any login is sent', async () => {
        const server = await fakePostgres('rogue-leaf', 'rogue-ca');
        try {
            const result = await tryConnect(server.port, pinFor(server.port, 'good-ca', 'good-leaf'));
            assert.doesNotMatch(result, /tls ok/);
            assert.match(result, /certificate/i);
        } finally {
            await server.close();
        }
    });

    test('a certificate from the pinned CA for another host fails the host check', async () => {
        const server = await fakePostgres('wrong-host', 'good-ca');
        try {
            const result = await tryConnect(server.port, pinFor(server.port, 'good-ca', 'good-leaf'));
            assert.match(result, /TLS host check failed/);
        } finally {
            await server.close();
        }
    });

    test('a rotated leaf passes by default and is refused with TIGER_PIN_LEAF', async () => {
        const server = await fakePostgres('second-leaf', 'good-ca');
        try {
            const loaded = pinFor(server.port, 'good-ca', 'good-leaf');
            assert.match(await tryConnect(server.port, loaded), /tls ok, test server/);
            assert.match(await tryConnect(server.port, loaded, true), /not the pinned leaf/);
        } finally {
            await server.close();
        }
    });
});

describe('the pin itself', () => {
    test('the committed pin loads and matches its certificate file', () => {
        const { pin, caPem } = loadPin();
        assert.equal(pin.host, 'ipx9051gbc.mz92ku10jd.tsdb.cloud.timescale.com');
        assert.equal(new X509Certificate(caPem).fingerprint256, pin.caSha256);
        assert.ok(!caPem.includes('PRIVATE KEY'));
    });

    test('a certificate file that does not match the recorded fingerprint is refused', () => {
        const bad = mkdtempSync(join(tmpdir(), 'telemetry-pin-'));
        try {
            const { pin } = loadPin();
            writeFileSync(join(bad, 'tiger-pin.json'), JSON.stringify(pin));
            writeFileSync(join(bad, pin.caFile), read('rogue-ca.crt'));
            assert.throws(() => loadPin(new URL(`file://${bad}/`)), (e: unknown) => e instanceof TlsPinError && /does not match the SHA-256/.test((e as Error).message));
        } finally {
            rmSync(bad, { recursive: true, force: true });
        }
    });

    test('an expired pinned CA is refused', () => {
        assert.throws(() => loadPin(undefined, new Date('2030-01-01T00:00:00Z')), (e: unknown) => e instanceof TlsPinError && /expired/.test((e as Error).message));
    });

    test('a target that is not the pinned host or port is refused before connecting', () => {
        const loaded = loadPin();
        assert.throws(() => pinnedSsl({ host: 'example.com', port: loaded.pin.port }, loaded), TlsPinError);
        assert.throws(() => pinnedSsl({ host: loaded.pin.host, port: 5432 }, loaded), TlsPinError);
        const ssl = pinnedSsl({ host: loaded.pin.host, port: loaded.pin.port }, loaded);
        assert.equal(ssl.rejectUnauthorized, true);
    });
});
