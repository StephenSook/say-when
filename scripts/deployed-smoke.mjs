#!/usr/bin/env node
/**
 * Smoke test of the DEPLOYED Eleven web app. A green CI run proves the code; this proves the site a judge opens.
 *
 *   cd scripts && npm ci && npx playwright install chromium
 *   DEPLOYED_URL=https://eleven-calhacks.vercel.app npm run smoke     (the default address; CI runs it hourly)
 *
 * Every check prints one line, PASS or FAIL, and the run exits 1 if any check failed.
 *
 * It never writes to the database. The dashboards (/live, /agents, /conversation, /judge) only read, as an anonymous
 * viewer. /partner is loaded but nothing is clicked: the phone pairs only after a person picks a label. /station and
 * /speaker are NOT opened in a browser, because loading either one sends `request_pairing` on its own
 * (web/lib/role/pairing.ts: station and speaker ask for a code at once), and that reducer inserts a pairing request
 * and its timer into the live demo database (spacetime/src/index.ts `requestPairing`). For those two pages the check
 * reads the server-rendered HTML instead, where no script runs.
 *
 * Console messages: only `error` messages count. None is allowed today: every page loaded with no console error on
 * Oct 24, 2026. The warnings seen then ("...was preloaded using link preload but not used within a few seconds", from
 * Next's CSS preloads) are warnings, so they do not count. A known benign error goes in BENIGN_CONSOLE_ERRORS with
 * a reason.
 */
import { chromium } from 'playwright';

const BASE_URL = baseUrl(process.env.DEPLOYED_URL || 'https://eleven-calhacks.vercel.app');
const MAINCLOUD_URL = 'https://maincloud.spacetimedb.com';
/** The databases the judge page links (web/components/judge/model.ts JUDGE_DATABASES). */
const STATS_DATABASES = ['say-when-demo', 'say-when-dev'];

const TITLE_SUFFIX = ', Eleven';
/** The sample replay's question (web/lib/data/replay.ts QUESTION_TEXT), on screen from 2.4 s into each loop. */
const REPLAY_QUESTION = 'Where can we get dinner near the hospital tonight?';
const REPLAY_BANNER = 'Sample replay, not live data';
/** What the judge page shows when a stats answer has no numbers to show (web/components/judge/model.ts STATS_WORDS). */
const JUDGE_STATS_FALLBACKS = ['No session yet.', 'The answer was not the stats. Open the link.', 'Could not load the stats here. Open the link.'];

/** Console errors that are not a defect of the site, each with its reason. Empty on purpose (see the header). */
const BENIGN_CONSOLE_ERRORS = [];

const STEP_TIMEOUT_MS = 20_000;
/** Page loads took up to 18 s over a slow network on Oct 24 (a query string also skips Vercel's prerender cache). */
const NAV_TIMEOUT_MS = 30_000;
/** After a page passes, how long to keep listening for a late page error or console error. */
const SETTLE_MS = 1_500;
/** One retry after a failure, so a single network blip does not page anyone; the line says it needed one. */
const RETRY_DELAY_MS = 3_000;
/** The whole run must finish inside this, well under the CI job's limit. */
const RUN_BUDGET_MS = 110_000;

/** Pages checked in a real browser: status 200, the title, no page error or console error, and what each must show. */
const BROWSER_PAGES = [
  { path: '/live', expect: liveDashboard },
  { path: '/live?replay=1', expect: replay },
  { path: '/agents', expect: liveDashboard },
  { path: '/conversation', expect: liveDashboard },
  { path: '/conversation?replay=1', expect: replay },
  { path: '/partner', expect: partner },
  { path: '/judge', expect: judge },
];

/** Pages checked from their server-rendered HTML only (no script runs), with text the HTML must hold. */
const HTML_PAGES = [
  { path: '/', finalPath: '/conversation', mustHold: [] },
  { path: '/station', finalPath: '/station', mustHold: ['Eleven station'] },
  { path: '/speaker', finalPath: '/speaker', mustHold: ['Eleven room voice', 'id="pairing-title-speaker"'] },
];

const results = [];

function baseUrl(raw) {
  const url = new URL(raw);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`DEPLOYED_URL must be http or https: ${raw}`);
  return url.origin;
}

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
}

/** Runs one check, retrying once after a failure. A check returns its detail line or throws. */
async function check(name, run) {
  const started = Date.now();
  const took = () => `[${((Date.now() - started) / 1000).toFixed(1)} s]`;
  let first;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const detail = await run();
      record(name, true, `${first ? `${detail} (passed on the second try; first: ${first})` : detail} ${took()}`);
      return;
    } catch (error) {
      const message = oneLine(error);
      if (attempt === 2) {
        record(name, false, `${first === message ? message : `${message} (first try: ${first})`} ${took()}`);
        return;
      }
      first = message;
      await sleep(RETRY_DELAY_MS);
    }
  }
}

function oneLine(error) {
  const text = error instanceof Error ? error.message : String(error);
  return text.split('\n')[0].slice(0, 300);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertTitle(title) {
  if (!title.endsWith(TITLE_SUFFIX)) throw new Error(`title ${JSON.stringify(title)} does not end with "${TITLE_SUFFIX}"`);
}

function decodeEntities(text) {
  return text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'");
}

async function htmlCheck({ path, finalPath, mustHold }) {
  const response = await fetch(BASE_URL + path, { redirect: 'follow', signal: AbortSignal.timeout(NAV_TIMEOUT_MS) });
  if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
  const landed = new URL(response.url);
  if (landed.origin !== BASE_URL || landed.pathname !== finalPath) {
    throw new Error(`landed on ${landed.origin}${landed.pathname}, expected ${BASE_URL}${finalPath}`);
  }
  const html = await response.text();
  const match = html.match(/<title>([^<]*)<\/title>/i);
  if (!match) throw new Error('no <title> in the HTML');
  const title = decodeEntities(match[1]);
  assertTitle(title);
  for (const text of mustHold) {
    if (!html.includes(text)) throw new Error(`the HTML does not hold ${JSON.stringify(text)}`);
  }
  const via = path === finalPath ? '' : `, landed on ${finalPath}`;
  return `200${via}, "${title}", server HTML only${mustHold.length ? `, holds ${mustHold.map((t) => JSON.stringify(t)).join(' and ')}` : ''}`;
}

async function browserCheck(browser, { path, expect }) {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(STEP_TIMEOUT_MS);
    const problems = [];
    page.on('pageerror', (error) => problems.push(`page error: ${oneLine(error)}`));
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      const text = message.text();
      if (BENIGN_CONSOLE_ERRORS.some((benign) => benign.pattern.test(text))) return;
      problems.push(`console error: ${text.split('\n')[0].slice(0, 200)}`);
    });

    // The checks below wait for what each page must show, so there is no need to wait for every font and image.
    const response = await page.goto(BASE_URL + path, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    if (!response) throw new Error('no response');
    if (response.status() !== 200) throw new Error(`HTTP ${response.status()}`);
    const landed = new URL(page.url());
    if (landed.origin !== BASE_URL) throw new Error(`landed on ${landed.origin}${landed.pathname}, outside ${BASE_URL}`);
    const title = await page.title();
    assertTitle(title);
    const shown = await expect(page);
    await page.waitForTimeout(SETTLE_MS);
    if (problems.length > 0) throw new Error(`${problems.length} error(s): ${problems.slice(0, 2).join(' | ')}`);
    return `200, "${title}", no errors, ${shown}`;
  } finally {
    await context.close();
  }
}

function connectionChip(page, word) {
  return page
    .locator('[role="status"][aria-label="Connection"]')
    .filter({ hasText: new RegExp(`\\b${word}\\b`) })
    .first();
}

/** A dashboard reading the live database: the connection chip says Live and the screen drew its heading. */
async function liveDashboard(page) {
  await connectionChip(page, 'Live').waitFor({ state: 'visible' });
  // Screen headings are visually hidden, so wait for them to exist rather than to be visible.
  const heading = page.locator('main h1').first();
  await heading.waitFor({ state: 'attached' });
  return `connected (Live), screen "${(await heading.textContent())?.trim()}"`;
}

async function replay(page) {
  await page.getByText(REPLAY_BANNER).first().waitFor({ state: 'visible' });
  await connectionChip(page, 'Replay').waitFor({ state: 'visible' });
  await page.getByText(REPLAY_QUESTION).first().waitFor({ state: 'visible' });
  return 'the sample replay shows its question';
}

async function partner(page) {
  await connectionChip(page, 'Live').waitFor({ state: 'visible' });
  // Read only: the label buttons stay untouched, so no pairing request is sent.
  await page.getByText('Pair this phone to ask').first().waitFor({ state: 'visible' });
  return 'connected (Live), pairing card shown, nothing clicked';
}

async function judge(page) {
  const measured = page.locator('section[aria-labelledby="judge-measured"] li');
  const notMeasured = page.locator('section[aria-labelledby="judge-not-measured"] li');
  await measured.first().waitFor({ state: 'visible' });
  await notMeasured.first().waitFor({ state: 'visible' });
  const measuredCount = await measured.count();
  const notMeasuredCount = await notMeasured.count();

  // The say-when-dev block: wait for its fetch to finish (aria-busy goes false), then read what it shows.
  const block = page.locator('li', { has: page.locator('span', { hasText: /^say-when-dev$/ }) });
  const stats = block.locator('[aria-busy="false"]');
  await stats.waitFor({ state: 'visible' });
  const values = (await stats.locator('dd').allInnerTexts()).map((v) => v.trim());
  let devLine;
  if (values.length > 0) {
    const bad = values.filter((v) => !/^\d+$/.test(v));
    if (bad.length > 0) throw new Error(`say-when-dev stats show non-numbers: ${bad.join(', ')}`);
    devLine = `say-when-dev stats: ${values.length} numbers, session ${values[0]}`;
  } else {
    const text = (await stats.innerText()).trim();
    if (!JUDGE_STATS_FALLBACKS.includes(text)) throw new Error(`say-when-dev stats show ${JSON.stringify(text)}`);
    devLine = `say-when-dev stats: the page's fallback "${text}"`;
  }
  return `Measured ${measuredCount} lines, Not measured yet ${notMeasuredCount} lines, ${devLine}`;
}

async function statsRouteCheck(db) {
  const url = `${MAINCLOUD_URL}/v1/database/${encodeURIComponent(db)}/route/stats`;
  const response = await fetch(url, { signal: AbortSignal.timeout(STEP_TIMEOUT_MS), cache: 'no-store' });
  if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
  const type = response.headers.get('content-type') ?? '';
  if (!type.includes('application/json')) throw new Error(`content-type ${JSON.stringify(type)}`);
  const body = await response.json();
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error('the answer is not a JSON object');
  if (!Number.isSafeInteger(body.sessionId)) throw new Error(`sessionId is ${JSON.stringify(body.sessionId)}`);
  const counts = Object.values(body).filter((v) => typeof v === 'number').length;
  return `200 JSON, session ${body.sessionId}, ${counts} numeric fields`;
}

async function main() {
  const started = Date.now();
  const budget = setTimeout(() => {
    console.log(`FAIL  run  over the ${RUN_BUDGET_MS / 1000} s budget; ${results.length} checks had finished`);
    process.exit(1);
  }, RUN_BUDGET_MS);
  budget.unref();

  console.log(`Smoke test of ${BASE_URL}`);
  for (const page of HTML_PAGES) await check(page.path, () => htmlCheck(page));
  for (const db of STATS_DATABASES) await check(`stats route ${db}`, () => statsRouteCheck(db));

  const browser = await chromium.launch();
  try {
    for (const page of BROWSER_PAGES) await check(page.path, () => browserCheck(browser, page));
  } finally {
    await browser.close();
  }

  const expected = HTML_PAGES.length + STATS_DATABASES.length + BROWSER_PAGES.length;
  const passed = results.filter((r) => r.ok).length;
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`${passed} of ${results.length} checks passed in ${seconds} s (expected ${expected} checks)`);
  // A floor on the count, so a run that skipped checks cannot pass.
  if (results.length !== expected || passed !== expected) process.exit(1);
}

main().catch((error) => {
  console.log(`FAIL  run  ${oneLine(error)}`);
  process.exit(1);
});
