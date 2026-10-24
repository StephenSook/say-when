/**
 * The judge page (PLAN 5.8) must not drift from the repo's docs. Every measured line quotes its cited doc section
 * verbatim, and every number on the line is in that quote, so changing a number in the model or in the doc turns this
 * red. Also: the itinerary, the stats view over the doc's own recorded answer, and the route rule.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  buildItinerary,
  buildJudgePage,
  citationLabel,
  citationUrl,
  keepUnits,
  MEASURED,
  NOT_MEASURED,
  numbersIn,
  REPO_URL,
  routeUrl,
  statsView,
  type Claim,
} from '../components/judge/model';
import { isJudgeRoute, isPhoneRoute, isRolePageRoute } from '../lib/routes';

const WEB = process.cwd();
const REPO = join(WEB, '..');

function readDoc(file: string): string {
  return readFileSync(join(REPO, file), 'utf8');
}

/**
 * The text of one doc section: from its heading to the next heading of the same or a higher level. `section` is the
 * start of the heading's title: "12.2" matches "### 12.2 Results", "8" matches "## 8. What not to claim", "Status"
 * matches "## Status". Lines inside fenced code blocks are never headings. Exactly one heading must match.
 */
function sectionOf(doc: string, section: string): string {
  const lines = doc.split('\n');
  const heads: { index: number; level: number; title: string }[] = [];
  let fenced = false;
  lines.forEach((line, index) => {
    if (/^\s*```/.test(line)) fenced = !fenced;
    if (fenced) return;
    const match = /^(#{1,6})\s+(.*)$/.exec(line);
    if (match) heads.push({ index, level: match[1]!.length, title: match[2]!.trim() });
  });
  const found = heads.filter((h) => h.title === section || h.title.startsWith(`${section} `) || h.title.startsWith(`${section}. `));
  assert.equal(found.length, 1, `exactly one heading "${section}" (found ${found.map((h) => h.title).join(' | ') || 'none'})`);
  const start = found[0]!;
  const next = heads.find((h) => h.index > start.index && h.level <= start.level);
  return lines.slice(start.index, next ? next.index : lines.length).join('\n');
}

function checkClaim(claim: Claim) {
  const doc = readDoc(claim.cite.file);
  const section = sectionOf(doc, claim.cite.section);
  assert.ok(section.includes(claim.evidence), `${citationLabel(claim.cite)} quotes "${claim.evidence}" verbatim`);
  assert.ok(doc.includes(claim.cite.date), `${claim.cite.file} carries the date ${claim.cite.date}`);
  const quoted = new Set(numbersIn(claim.evidence));
  for (const n of numbersIn(claim.text)) {
    assert.ok(quoted.has(n), `"${claim.text}": ${n} is in the quote from ${citationLabel(claim.cite)}`);
  }
}

describe('judge page model', () => {
  test('the section finder reads the right section and only that section', () => {
    const spacetime = readDoc('docs/spacetime.md');
    const results = sectionOf(spacetime, '12.2');
    assert.ok(results.startsWith('### 12.2 Results'));
    assert.ok(results.includes('1501 to 1502 ms'));
    assert.ok(!results.includes('### 12.3'), 'stops at the next heading of its level');
    const notClaimed = sectionOf(readDoc('docs/station.md'), '8');
    assert.ok(notClaimed.startsWith('## 8. What not to claim'));
    assert.ok(!notClaimed.includes('1501'), 'section 8 does not hold the smoke numbers');
    assert.ok(!notClaimed.includes('## 9.'), 'stops before section 9');
    assert.throws(() => sectionOf(spacetime, '99.9'), /exactly one heading/);
    assert.ok(sectionOf(readDoc('README.md'), 'Status').includes('| Part | Folder | State |'));
  });

  test('the number check catches a number that is not in the quote', () => {
    const real = MEASURED.find((c) => c.text.includes('1501'));
    assert.ok(real, 'the dead-man line exists');
    assert.throws(() => checkClaim({ ...real, text: real.text.replace('1502', '1503') }), /1503/);
    assert.throws(() => checkClaim({ ...real, evidence: real.evidence.replace('1502', '1503') }), /verbatim/);
    assert.deepEqual(numbersIn('build 0.1.4, 11 of 13, 52 ms'), ['0.1.4', '11', '13', '52']);
  });

  test('every measured line quotes its cited section, numbers included', () => {
    assert.ok(MEASURED.length >= 5, `${MEASURED.length} measured lines`);
    for (const claim of MEASURED) checkClaim(claim);
    const withNumbers = MEASURED.filter((c) => numbersIn(c.text).length > 0);
    assert.ok(withNumbers.length >= 5, `${withNumbers.length} measured lines state a number, so the number check is not vacuous`);
  });

  test('every "not measured yet" line quotes its cited section', () => {
    assert.ok(NOT_MEASURED.length >= 5, `${NOT_MEASURED.length} lines`);
    for (const claim of NOT_MEASURED) checkClaim(claim);
    const fromSection8 = NOT_MEASURED.filter((c) => c.cite.file === 'docs/station.md' && c.cite.section === '8');
    assert.ok(fromSection8.length >= 4, 'most come from docs/station.md section 8');
    const texts = NOT_MEASURED.map((c) => c.text).join('\n');
    for (const must of [/no wearer/i, /key presses/i, /brain test/i, /no voice/i, /latency/i]) assert.match(texts, must);
  });

  test('the rest of the page states no number of its own', () => {
    const page = buildJudgePage();
    const lines = [
      page.title,
      page.lead,
      page.signals,
      page.safety,
      page.tourTitle,
      ...page.itinerary.flatMap((s) => [s.title, s.line]),
      page.replay.before,
      page.replay.link,
      page.checkTitle,
      ...page.databases.map((d) => d.note),
      ...page.links.map((l) => l.label),
      page.measuredTitle,
      page.notMeasuredTitle,
    ];
    const numbers = lines.flatMap(numbersIn);
    assert.deepEqual(numbers, ['390'], 'only the phone width');
    assert.ok(readDoc('docs/ui.md').includes('390 px'), 'docs/ui.md sets the 390 px phone check');
  });

  test('the components print no measurement of their own', () => {
    const dir = join(WEB, 'components', 'judge');
    const files = readdirSync(dir).filter((f) => /\.tsx$/.test(f));
    assert.ok(files.length >= 2, `checked ${files.join(', ')}`);
    for (const file of files) {
      const text = readFileSync(join(dir, file), 'utf8');
      assert.doesNotMatch(text, /\d+\s?ms\b/, `${file} has no hard-coded time`);
      assert.doesNotMatch(text, /\d+ of \d+/, `${file} has no hard-coded count`);
      assert.match(text, /from '\.\/model'|from '@\/components\/judge\/model'/, `${file} reads the model`);
    }
  });

  test('the signals are the two the README names, and the page denies any thought claim', () => {
    const page = buildJudgePage();
    const readme = readDoc('README.md');
    assert.ok(readme.includes('imagined movements read over the motor cortex'));
    assert.ok(readme.includes('The jaw clench is a muscle signal'));
    assert.match(page.signals, /read over the motor cortex/);
    assert.match(page.signals, /a muscle signal/);
    assert.match(page.signals, /No thoughts are read\./);
    assert.match(page.safety, /fresh CONFIRM/);
  });

  test('the itinerary is four numbered stops with one line each', () => {
    const steps = buildItinerary();
    assert.deepEqual(
      steps.map((s) => [s.n, s.title, s.href]),
      [
        [1, 'Live data', '/live'],
        [2, 'Conversation', '/conversation'],
        [3, 'Agents', '/agents'],
        [4, 'Partner phone', '/partner'],
      ],
    );
    for (const step of steps) {
      assert.ok(step.line.length > 0 && step.line.length <= 70, `"${step.line}" is one short line`);
      assert.ok(!step.line.includes('\n'));
    }
    assert.equal(buildJudgePage().replay.href, '/conversation?replay=1');
  });

  test('the check links are the public addresses the docs give', () => {
    const readme = readDoc('README.md');
    assert.equal(routeUrl('say-when-dev', 'stats'), 'https://maincloud.spacetimedb.com/v1/database/say-when-dev/route/stats');
    assert.ok(readme.includes(routeUrl('say-when-dev', 'stats')), 'README gives the same stats address');
    assert.equal(routeUrl('say-when-demo', 'ping'), 'https://maincloud.spacetimedb.com/v1/database/say-when-demo/route/ping');
    const page = buildJudgePage();
    assert.deepEqual(
      page.databases.map((d) => d.db),
      ['say-when-demo', 'say-when-dev'],
    );
    for (const link of page.links) assert.ok(readme.includes(link.href), `README names ${link.href}`);
    assert.ok(readme.includes('https://github.com/StephenSook/say-when.git'));
    assert.equal(REPO_URL, 'https://github.com/StephenSook/say-when');
  });

  test('a number stays on the line with its unit, and the numbers do not change', () => {
    const nbsp = String.fromCharCode(0xa0);
    assert.equal(keepUnits('a median 2 ms, max 10 ms, at 390 px, 4 of 4'), `a median 2${nbsp}ms, max 10${nbsp}ms, at 390${nbsp}px, 4 of 4`);
    for (const claim of MEASURED) assert.deepEqual(numbersIn(keepUnits(claim.text)), numbersIn(claim.text));
    assert.equal(keepUnits('msg 2 msgs'), 'msg 2 msgs', 'only whole units');
  });

  test('a citation reads as file, section and date, and links to the file on GitHub', () => {
    const cite = { file: 'docs/spacetime.md', section: '12.2', date: 'Oct 24' } as const;
    assert.equal(citationLabel(cite), 'docs/spacetime.md 12.2, Oct 24');
    assert.equal(citationUrl(cite), 'https://github.com/StephenSook/say-when/blob/main/docs/spacetime.md');
  });

  test('the page model is a fresh copy each time', () => {
    const a = buildJudgePage();
    a.measured[0]!.text = 'changed';
    a.itinerary[0]!.title = 'changed';
    const b = buildJudgePage();
    assert.notEqual(b.measured[0]!.text, 'changed');
    assert.notEqual(b.itinerary[0]!.title, 'changed');
  });
});

describe('stats view', () => {
  test("reads the stats answer recorded in docs/spacetime.md 12.2", () => {
    const recorded = /\{"sessionId":3,[^}]*\}/.exec(sectionOf(readDoc('docs/spacetime.md'), '12.2'));
    assert.ok(recorded, 'the doc records a stats answer');
    const view = statsView(JSON.parse(recorded[0]));
    assert.equal(view.kind, 'session');
    if (view.kind !== 'session') return;
    assert.equal(view.session, 3);
    assert.deepEqual(
      view.fields.map((f) => `${f.label} ${f.value}`),
      ['Questions 4', 'Answered 3', 'Picks 3', 'Late picks 1', 'Pauses 1', 'Errands sent 1', 'Errands stopped 0', 'Commands 9', 'Ignored 5'],
    );
  });

  test('session 0 is no session yet, as the empty demo database answers', () => {
    const empty = {
      sessionId: 0,
      questions: 0,
      questionsAnswered: 0,
      picks: 0,
      medianLateByMs: null,
      latePicks: 0,
      pauses: 0,
      medianPauseLatencyMs: null,
      medianQuestionToFirstOptionMs: null,
      errandsSent: 0,
      errandsStopped: 0,
      gestures: 0,
      gesturesIgnored: 0,
    };
    assert.deepEqual(statsView(empty), { kind: 'no_session' });
  });

  test('leaves out what is missing or not a count, and never invents a value', () => {
    const view = statsView({ sessionId: 7, picks: 2, latePicks: '1', pauses: -1, gestures: 1.5, errandsSent: null });
    assert.deepEqual(view, { kind: 'session', session: 7, fields: [{ label: 'Picks', value: 2 }] });
  });

  test('anything else is invalid', () => {
    for (const body of [null, undefined, 'ok', 3, [], [3], {}, { sessionId: '3', picks: 1 }, { sessionId: -1, picks: 1 }, { sessionId: 2.5, picks: 1 }, { sessionId: 4 }, { ok: true, at: 1 }]) {
      assert.deepEqual(statsView(body), { kind: 'invalid' }, JSON.stringify(body) ?? String(body));
    }
  });
});

describe('judge route', () => {
  test('/judge is the judge page, not a role page or the phone', () => {
    for (const path of ['/judge', '/judge/']) assert.equal(isJudgeRoute(path), true, path);
    for (const path of ['/', '/live', '/judges', '/partner', '/station', null, '']) assert.equal(isJudgeRoute(path), false, String(path));
    assert.equal(isRolePageRoute('/judge'), false);
    assert.equal(isPhoneRoute('/judge'), false);
  });

  test('the shell skips the connection gate on the judge page and links to it', () => {
    const shell = readFileSync(join(WEB, 'components', 'shell', 'Shell.tsx'), 'utf8');
    assert.match(shell, /isJudgeRoute\(pathname\)/);
    assert.match(shell, /<JudgeLink/);
    const page = readFileSync(join(WEB, 'app', 'judge', 'page.tsx'), 'utf8');
    assert.match(page, /title: 'For judges'/);
  });
});
