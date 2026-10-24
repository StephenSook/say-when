import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import type { Browser } from 'playwright';

import { launchBrowser } from '../src/browser.js';
import { runErrand, type ErrandDeps } from '../src/errand.js';
import { SubmitLedger, type RecordStore } from '../src/ledger.js';
import type { ErrandInput, FieldInput } from '../src/types.js';
import { parseInput } from '../src/validate.js';
import { startFixtures, type FixtureServer } from './fixtures.js';

class MemoryStore implements RecordStore {
    readonly data = new Map<string, unknown>();
    async getValue<T>(key: string): Promise<T | null> {
        return (this.data.get(key) as T | undefined) ?? null;
    }
    async setValue(key: string, value: unknown): Promise<void> {
        if (value === null) this.data.delete(key);
        else this.data.set(key, value);
    }
}

const CARE: FieldInput[] = [
    { label: 'Who is this from?', value: 'Demo user', source: 'memory' },
    { label: 'What do you need?', value: 'Meal or drink' },
    { label: 'Details', value: 'Lunch at the cafe across the street.' },
    { label: 'When?', value: '12:30 today' },
    { label: 'How urgent?', value: 'Today' },
];

let browser: Browser;
let fixtures: FixtureServer;

before(async () => {
    browser = await launchBrowser();
    fixtures = await startFixtures();
});

after(async () => {
    await browser?.close();
    await fixtures?.close();
});

function makeDeps(extra: Partial<ErrandDeps> = {}): ErrandDeps {
    return {
        browser,
        ledger: new SubmitLedger(new MemoryStore()),
        screenshots: { save: async () => null },
        allowedPrefixes: [],
        allowLocal: true,
        ...extra,
    };
}

const input = (raw: Record<string, unknown>): ErrandInput => parseInput(raw);

describe('native HTML form', () => {
    it('inspect lists every question with its choices', async () => {
        const r = await runErrand(input({ formUrl: `${fixtures.base}/care`, mode: 'inspect' }), makeDeps());
        assert.equal(r.status, 'inspected');
        assert.equal(r.formTitle, 'Care team request');
        assert.equal(r.fillAllowed, true);
        const need = r.questions.find((q) => q.label === 'What do you need?');
        assert.deepEqual(need?.options, ['Ride', 'Meal or drink', 'Company', 'Something else']);
        assert.equal(need?.kind, 'choice');
        assert.equal(r.questions.find((q) => q.label === 'Who is this from?')?.required, true);
        assert.equal(r.questions.length, 5);
    });

    it('preview reads back exactly what the page holds, adds the note, and never sends', async () => {
        const deps = makeDeps();
        const r = await runErrand(input({ formUrl: `${fixtures.base}/care`, fields: CARE }), deps);
        assert.equal(r.status, 'previewed');
        assert.deepEqual(r.unmatched, []);
        assert.deepEqual(r.missingRequired, []);
        const value = (label: string) => r.readBack.find((i) => i.label === label)?.value;
        assert.equal(value('Who is this from?'), 'Demo user');
        assert.equal(value('What do you need?'), 'Meal or drink');
        assert.equal(value('How urgent?'), 'Today');
        assert.match(value('Details') ?? '', /Lunch at the cafe across the street\.\s+Sent with an assistive switch/);
        assert.equal(r.readBack.find((i) => i.label === 'Who is this from?')?.source, 'memory');
        assert.match(r.previewDigest ?? '', /^[0-9a-f]{16}$/);
        assert.match(r.readBackText ?? '', /^To Care team request\. Who is this from: Demo user\. What do you need: Meal or drink\./);
        assert.match(r.readBackText ?? '', /plus a note saying how it was sent\./);
        assert.ok((r.screenshotBase64 ?? '').length > 1000);
        assert.equal(fixtures.count('/demo-form/submit'), 0);
    });

    it('gives the same digest for the same answers', async () => {
        const a = await runErrand(input({ formUrl: `${fixtures.base}/care`, fields: CARE }), makeDeps());
        const b = await runErrand(input({ formUrl: `${fixtures.base}/care`, fields: [...CARE].reverse() }), makeDeps());
        assert.equal(a.previewDigest, b.previewDigest);
    });

    it('submit refuses without a confirm, with a stale digest, then sends once and refuses the repeat', async () => {
        const deps = makeDeps();
        const preview = await runErrand(input({ formUrl: `${fixtures.base}/care`, fields: CARE }), deps);
        const digest = preview.previewDigest ?? '';
        const submit = (extra: Record<string, unknown>) =>
            runErrand(input({ formUrl: `${fixtures.base}/care`, fields: CARE, mode: 'submit', ...extra }), deps);

        assert.equal((await submit({ confirm: false, confirmDigest: digest })).refusal?.code, 'not_confirmed');
        assert.equal((await submit({ confirm: true, confirmDigest: '0000000000000000' })).refusal?.code, 'digest_mismatch');
        assert.equal((await submit({ confirm: true })).refusal?.code, 'digest_mismatch');
        assert.equal(fixtures.count('/demo-form/submit'), 0);

        const sent = await submit({ confirm: true, confirmDigest: digest });
        assert.equal(sent.status, 'submitted');
        assert.match(sent.confirmationText ?? '', /Request received/);
        assert.equal(fixtures.count('/demo-form/submit'), 1);

        const again = await submit({ confirm: true, confirmDigest: digest });
        assert.equal(again.status, 'duplicate');
        assert.match(again.confirmationText ?? '', /Request received/);
        assert.equal(fixtures.count('/demo-form/submit'), 1);
    });

    it('a changed answer after the read-back changes the digest, so the old confirm cannot send it', async () => {
        const deps = makeDeps();
        const preview = await runErrand(input({ formUrl: `${fixtures.base}/care`, fields: CARE }), deps);
        const changed = CARE.map((f) => (f.label === 'When?' ? { ...f, value: '1:30 today' } : f));
        const r = await runErrand(
            input({ formUrl: `${fixtures.base}/care`, fields: changed, mode: 'submit', confirm: true, confirmDigest: preview.previewDigest }),
            deps,
        );
        assert.equal(r.refusal?.code, 'digest_mismatch');
    });

    it('reports empty required questions and refuses to send them', async () => {
        const deps = makeDeps();
        const partial = CARE.filter((f) => f.label !== 'Who is this from?');
        const preview = await runErrand(input({ formUrl: `${fixtures.base}/care`, fields: partial }), deps);
        assert.deepEqual(preview.missingRequired, ['Who is this from?']);
        const r = await runErrand(
            input({ formUrl: `${fixtures.base}/care`, fields: partial, mode: 'submit', confirm: true, confirmDigest: preview.previewDigest }),
            deps,
        );
        assert.equal(r.refusal?.code, 'missing_required');
    });

    it('reports answers with no matching question and refuses to send', async () => {
        const deps = makeDeps();
        const fields = [...CARE, { label: 'Favorite color', value: 'blue' }];
        const preview = await runErrand(input({ formUrl: `${fixtures.base}/care`, fields }), deps);
        assert.deepEqual(preview.unmatched, ['Favorite color (no such question)']);
        const r = await runErrand(
            input({ formUrl: `${fixtures.base}/care`, fields, mode: 'submit', confirm: true, confirmDigest: preview.previewDigest }),
            deps,
        );
        assert.equal(r.refusal?.code, 'unmatched_fields');
    });

    it('reports a choice that does not exist', async () => {
        const fields = CARE.map((f) => (f.label === 'How urgent?' ? { ...f, value: 'Next year' } : f));
        const r = await runErrand(input({ formUrl: `${fixtures.base}/care`, fields }), makeDeps());
        assert.deepEqual(r.unmatched, ['How urgent? (no choice named "Next year")']);
    });
});

describe('consent and refusals', () => {
    it('a form without the opt-in marker can be inspected but not filled', async () => {
        const inspected = await runErrand(input({ formUrl: `${fixtures.base}/plain`, mode: 'inspect' }), makeDeps());
        assert.equal(inspected.status, 'inspected');
        assert.equal(inspected.fillAllowed, false);
        const r = await runErrand(input({ formUrl: `${fixtures.base}/plain`, fields: CARE }), makeDeps());
        assert.equal(r.refusal?.code, 'not_allowed');
        assert.equal(r.readBack.length, 0);
    });

    it('the operator allowlist lets a form without the marker be filled', async () => {
        const r = await runErrand(
            input({ formUrl: `${fixtures.base}/plain`, fields: CARE }),
            makeDeps({ allowedPrefixes: [`${fixtures.base}/plain`] }),
        );
        assert.equal(r.status, 'previewed');
    });

    for (const [path, code] of [
        ['/captcha', 'captcha'],
        ['/login', 'login'],
        ['/pay', 'payment'],
        ['/upload', 'upload'],
        ['/empty', 'no_form'],
    ] as const) {
        it(`refuses ${path} with ${code}`, async () => {
            const r = await runErrand(input({ formUrl: `${fixtures.base}${path}`, fields: [{ label: 'Name', value: 'x' }] }), makeDeps());
            assert.equal(r.status, 'refused');
            assert.equal(r.refusal?.code, code);
        });
    }

    it('refuses a redirect to a private address', async () => {
        const r = await runErrand(input({ formUrl: `${fixtures.base}/redirect-private`, fields: CARE }), makeDeps());
        assert.equal(r.refusal?.code, 'bad_url');
        assert.equal(r.screenshotBase64, undefined);
    });

    it('refuses a page that loads anything from a private address, and takes no screenshot', async () => {
        const r = await runErrand(input({ formUrl: `${fixtures.base}/img-private`, fields: [{ label: 'Name', value: 'x' }] }), makeDeps());
        assert.equal(r.refusal?.code, 'bad_url');
        assert.equal(r.screenshotBase64, undefined);
    });

    it('refuses plain http outside tests', async () => {
        const r = await runErrand(input({ formUrl: `${fixtures.base}/care`, fields: CARE }), makeDeps({ allowLocal: false }));
        assert.equal(r.refusal?.code, 'bad_url');
    });

    it('reports a page that does not load', async () => {
        const r = await runErrand(input({ formUrl: `${fixtures.base}/missing`, fields: CARE }), makeDeps());
        assert.equal(r.refusal?.code, 'load_failed');
    });
});

describe('ARIA form in the style of Google Forms', () => {
    const fields: FieldInput[] = [
        { label: 'Who is this from?', value: 'Demo user' },
        { label: 'What do you need?', value: 'Company' },
        { label: 'Details', value: 'Coffee and a chat this afternoon.' },
        { label: 'Extras', value: ['Wheelchair space', 'Quiet table'] },
    ];

    it('fills radio groups, checkbox lists and labelled-by inputs, then submits', async () => {
        const deps = makeDeps();
        const preview = await runErrand(input({ formUrl: `${fixtures.base}/aria`, fields }), deps);
        assert.equal(preview.status, 'previewed');
        assert.deepEqual(preview.unmatched, []);
        assert.deepEqual(preview.missingRequired, []);
        const value = (label: string) => preview.readBack.find((i) => i.label === label)?.value;
        assert.equal(value('What do you need?'), 'Company');
        assert.equal(value('Extras'), 'Wheelchair space, Quiet table');
        const kinds = Object.fromEntries(preview.questions.map((q) => [q.label, q.kind]));
        assert.equal(kinds['What do you need?'], 'choice');
        assert.equal(kinds.Extras, 'checkboxes');

        const sent = await runErrand(
            input({ formUrl: `${fixtures.base}/aria`, fields, mode: 'submit', confirm: true, confirmDigest: preview.previewDigest }),
            deps,
        );
        assert.equal(sent.status, 'submitted');
        assert.equal(sent.confirmationText, 'Your response has been recorded.');
        assert.equal(fixtures.count('/aria/submit'), 1);
    });

    it('reports an empty required radio group', async () => {
        const r = await runErrand(
            input({ formUrl: `${fixtures.base}/aria`, fields: fields.filter((f) => f.label !== 'What do you need?') }),
            makeDeps(),
        );
        assert.deepEqual(r.missingRequired, ['What do you need?']);
    });
});

describe('built-in demo form', () => {
    it('previews and submits with formUrl demo, using a digest that survives a new run', async () => {
        const deps = makeDeps({ allowLocal: false });
        const preview = await runErrand(input({ formUrl: 'demo', fields: CARE }), deps);
        assert.equal(preview.status, 'previewed');
        assert.equal(preview.finalUrl, 'demo');
        const sent = await runErrand(
            input({ formUrl: 'demo', fields: CARE, mode: 'submit', confirm: true, confirmDigest: preview.previewDigest }),
            makeDeps({ allowLocal: false }),
        );
        assert.equal(sent.status, 'submitted');
        assert.match(sent.confirmationText ?? '', /nothing was sent anywhere/);
    });
});
