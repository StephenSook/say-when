import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A built-in "Care team request" form so anyone can try the full preview, read back and submit flow
 * with formUrl "demo". It runs inside the Actor run and sends nothing anywhere.
 */
export const DEMO_FORM_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="form-errand" content="allow">
<title>Care team request</title>
<style>
  body { font: 18px/1.5 system-ui, sans-serif; max-width: 640px; margin: 32px auto; padding: 0 16px; color: #1b1b1f; }
  fieldset { border: 1px solid #c9c9d1; border-radius: 8px; margin: 0 0 20px; padding: 12px 16px; }
  label { display: block; margin: 0 0 6px; font-weight: 600; }
  fieldset label { font-weight: 400; display: flex; gap: 8px; align-items: center; }
  input[type=text], textarea { width: 100%; box-sizing: border-box; font: inherit; padding: 8px; border: 1px solid #8a8a96; border-radius: 6px; }
  .q { margin: 0 0 20px; }
  button { font: inherit; padding: 10px 20px; border-radius: 6px; border: 0; background: #2350c8; color: #fff; }
</style>
</head>
<body>
<h1>Care team request</h1>
<p>Demo form built into the form-errand Actor. Nothing typed here leaves the Actor run.</p>
<form method="post" action="/demo-form/submit">
  <div class="q">
    <label for="from">Who is this from?</label>
    <input id="from" name="from" type="text" required>
  </div>
  <fieldset>
    <legend>What do you need?</legend>
    <label><input type="radio" name="need" value="Ride" required> Ride</label>
    <label><input type="radio" name="need" value="Meal or drink"> Meal or drink</label>
    <label><input type="radio" name="need" value="Company"> Company</label>
    <label><input type="radio" name="need" value="Something else"> Something else</label>
  </fieldset>
  <div class="q">
    <label for="details">Details</label>
    <textarea id="details" name="details" rows="4"></textarea>
  </div>
  <div class="q">
    <label for="when">When?</label>
    <input id="when" name="when" type="text">
  </div>
  <fieldset>
    <legend>How urgent?</legend>
    <label><input type="radio" name="urgency" value="Now"> Now</label>
    <label><input type="radio" name="urgency" value="Today"> Today</label>
    <label><input type="radio" name="urgency" value="This week"> This week</label>
  </fieldset>
  <button type="submit">Submit</button>
</form>
</body>
</html>`;

export const DEMO_CONFIRMATION_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Care team request</title></head>
<body style="font: 18px/1.5 system-ui, sans-serif; max-width: 640px; margin: 32px auto; padding: 0 16px;">
<h1>Care team request</h1>
<p>Request received. This is the built-in demo form, so nothing was sent anywhere.</p>
</body></html>`;

export interface DemoServer {
    url: string;
    /** Number of submissions the demo form received in this run. */
    submissions: () => number;
    close: () => Promise<void>;
}

export async function startDemoServer(): Promise<DemoServer> {
    let received = 0;
    const server: Server = createServer((req, res) => {
        if (req.method === 'GET' && req.url?.split('?')[0] === '/demo-form') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(DEMO_FORM_HTML);
            return;
        }
        if (req.method === 'POST' && req.url === '/demo-form/submit') {
            req.resume();
            req.on('end', () => {
                received += 1;
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(DEMO_CONFIRMATION_HTML);
            });
            return;
        }
        res.writeHead(404);
        res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return {
        url: `http://127.0.0.1:${port}/demo-form`,
        submissions: () => received,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
}
