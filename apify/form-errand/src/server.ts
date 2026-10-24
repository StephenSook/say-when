import http from 'node:http';

export type Route = '/inspect' | '/preview' | '/submit';
export type RouteHandler = (route: Route, body: unknown) => Promise<{ status: number; body: unknown }>;

const ROUTES: Route[] = ['/inspect', '/preview', '/submit'];
const MAX_BODY_BYTES = 256 * 1024;

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                reject(new Error('too large'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

/**
 * The Standby web server. Answers the platform readiness probe, describes itself on GET /,
 * and runs one errand at a time so a warm browser never holds two forms at once.
 */
export function createErrandServer(handler: RouteHandler, about: Record<string, unknown>): http.Server {
    let queue: Promise<unknown> = Promise.resolve();
    return http.createServer((req, res) => {
        if (req.headers['x-apify-container-server-readiness-probe']) {
            res.writeHead(200);
            res.end('ok');
            return;
        }
        const path = (req.url ?? '/').split('?')[0];
        if (req.method === 'GET' && path === '/') {
            sendJson(res, 200, about);
            return;
        }
        if (req.method !== 'POST' || !ROUTES.includes(path as Route)) {
            sendJson(res, 404, { error: 'Not found. Use POST /inspect, /preview or /submit.' });
            return;
        }
        readBody(req).then(
            (raw) => {
                let body: unknown;
                try {
                    body = raw ? JSON.parse(raw) : {};
                } catch {
                    sendJson(res, 400, { error: 'The body must be JSON.' });
                    return;
                }
                const run = queue.then(() => handler(path as Route, body));
                queue = run.catch(() => undefined);
                run.then(
                    (out) => sendJson(res, out.status, out.body),
                    () => sendJson(res, 500, { error: 'Internal error. Nothing was sent.' }),
                );
            },
            () => sendJson(res, 413, { error: 'The body is too large.' }),
        );
    });
}
