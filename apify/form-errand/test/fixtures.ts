import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { DEMO_CONFIRMATION_HTML, DEMO_FORM_HTML } from '../src/demo-form.js';

const OPT_IN_META = '<meta name="form-errand" content="allow">';

const page = (body: string, optIn = true) =>
    `<!doctype html><html><head><meta charset="utf-8"><title>Fixture</title>${optIn ? OPT_IN_META : ''}</head><body>${body}</body></html>`;

/** A Google Forms style page: ARIA radio groups, labelled-by inputs, question cards, a div button. */
const ARIA_FORM = `<!doctype html><html><head><meta charset="utf-8"><title>Care team request</title>
<style>[role=radio],[role=checkbox]{display:inline-block;width:18px;height:18px;border:1px solid #333;margin-right:6px}</style>
</head><body>
<div role="heading" aria-level="1">Care team request</div>
<div>Assisted submissions welcome (form-errand:allow)</div>
<div role="list">
  <div role="listitem">
    <div role="heading" aria-level="3" id="q1">Who is this from? <span>*</span></div>
    <input type="text" aria-labelledby="q1" aria-required="true">
  </div>
  <div role="listitem">
    <div role="heading" aria-level="3" id="q2">What do you need? <span>*</span></div>
    <div role="radiogroup" aria-labelledby="q2" aria-required="true">
      <div><span role="radio" aria-checked="false" aria-label="Ride" tabindex="0"></span>Ride</div>
      <div><span role="radio" aria-checked="false" aria-label="Meal or drink" tabindex="0"></span>Meal or drink</div>
      <div><span role="radio" aria-checked="false" aria-label="Company" tabindex="0"></span>Company</div>
    </div>
  </div>
  <div role="listitem">
    <div role="heading" aria-level="3" id="q3">Details</div>
    <textarea aria-labelledby="q3"></textarea>
  </div>
  <div role="listitem">
    <div role="heading" aria-level="3" id="q4">Extras</div>
    <div role="list" aria-labelledby="q4">
      <div role="listitem"><span role="checkbox" aria-checked="false" aria-label="Wheelchair space" tabindex="0"></span>Wheelchair space</div>
      <div role="listitem"><span role="checkbox" aria-checked="false" aria-label="Quiet table" tabindex="0"></span>Quiet table</div>
    </div>
  </div>
</div>
<div role="button" tabindex="0" id="send"><span>Submit</span></div>
<div role="button" tabindex="0"><span>Clear form</span></div>
<script>
  document.querySelectorAll('[role=radio]').forEach(function (r) {
    r.addEventListener('click', function () {
      r.closest('[role=radiogroup]').querySelectorAll('[role=radio]').forEach(function (x) { x.setAttribute('aria-checked', 'false'); });
      r.setAttribute('aria-checked', 'true');
    });
  });
  document.querySelectorAll('[role=checkbox]').forEach(function (c) {
    c.addEventListener('click', function () { c.setAttribute('aria-checked', c.getAttribute('aria-checked') === 'true' ? 'false' : 'true'); });
  });
  document.getElementById('send').addEventListener('click', function () {
    fetch('/aria/submit', { method: 'POST', body: '{}' }).then(function () {
      document.body.innerHTML = '<div role="heading" aria-level="1">Care team request</div><div>Your response has been recorded.</div>';
    });
  });
</script>
</body></html>`;

export interface FixtureServer {
    base: string;
    count: (path: string) => number;
    close: () => Promise<void>;
}

export async function startFixtures(): Promise<FixtureServer> {
    const posts = new Map<string, number>();
    const routes: Record<string, string> = {
        '/care': DEMO_FORM_HTML,
        '/plain': DEMO_FORM_HTML.replace(OPT_IN_META, ''),
        '/aria': ARIA_FORM,
        '/captcha': page('<form><label for="a">Name</label><input id="a"><div class="g-recaptcha" data-sitekey="x"></div></form>'),
        '/login': page('<form><label for="u">Email</label><input id="u"><label for="p">Password</label><input id="p" type="password"></form>'),
        '/pay': page('<form><label for="c">Card number</label><input id="c" autocomplete="cc-number"></form>'),
        '/upload': page('<form><label for="f">Attach</label><input id="f" type="file"></form>'),
        '/empty': page('<p>No form here.</p>'),
        '/img-private': page('<form><label for="a">Name</label><input id="a"></form><img src="http://10.0.0.1/x.png" alt="">'),
    };
    const server: Server = createServer((req, res) => {
        const path = (req.url ?? '/').split('?')[0];
        if (path === '/redirect-private') {
            res.writeHead(302, { Location: 'http://0.0.0.0:9/form' });
            res.end();
            return;
        }
        if (req.method === 'POST') {
            req.resume();
            req.on('end', () => {
                posts.set(path, (posts.get(path) ?? 0) + 1);
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(path === '/aria/submit' ? '{}' : DEMO_CONFIRMATION_HTML);
            });
            return;
        }
        const html = routes[path];
        res.writeHead(html ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html ?? 'not found');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return {
        base: `http://127.0.0.1:${port}`,
        count: (path) => posts.get(path) ?? 0,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
}
