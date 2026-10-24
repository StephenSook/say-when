// The speed changes: the yes or no fast path (src/fastpath.ts) and draft first (src/jobs.ts, AGENT_DRAFT_FIRST).

import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { ApifyHttpError } from '@say-when/apify-client';

import { readConfig } from '../src/config.js';
import { classifyYesNo, stockYesNo } from '../src/fastpath.js';
import { validatePlan } from '../src/planner/validate.js';
import { fourOptions, harness, LEON, memoryHit, reply, settle, waitFor, yesNo, type Harness } from './helpers.js';

let open: Harness | null = null;
afterEach(async () => {
    await open?.orchestrator.stop(1_000);
    open = null;
});

function start(h: Harness): Harness {
    open = h;
    h.orchestrator.start();
    return h;
}

const POSITIVES = [
    'Are you tired?',
    'Do you want some water?',
    'did you sleep well',
    'Does it hurt?',
    'Is the pharmacy on Bancroft still open?',
    'Was it fun?',
    'Were you there?',
    'Can you hear me?',
    'Could you sleep last night?',
    'Will you come with us?',
    'Would you like to go outside?',
    'Should I call the nurse?',
    'Shall we go?',
    'Have you eaten yet?',
    'Has Leon called?',
    'Had you met her before?',
    'May I sit here?',
    'Might you be cold?',
    '  ARE YOU OK?  ',
    '“Are you cold?”',
    'Smoke test: tired? [yes_no]',
    'Smoke test: tea or coffee? [yes_no]',
];

const NEGATIVES: [string, string][] = [
    ['Tea or coffee?', 'no_auxiliary'],
    ['Do you want tea or coffee?', 'or_choice'],
    ['Would you rather walk, or take the bus?', 'or_choice'],
    ['Do you want either one?', 'or_choice'],
    ['What do you want for lunch?', 'no_auxiliary'],
    ['Do you know where the station is?', 'wh_word'],
    ['Can you tell me how you feel?', 'wh_word'],
    ['Is it the one which you liked?', 'wh_word'],
    ['Do you know whether it rained?', 'wh_word'],
    ['Where should we eat?', 'no_auxiliary'],
    ['How are you feeling?', 'no_auxiliary'],
    ["Don't forget your pills.", 'no_auxiliary'],
    ["Isn't it cold?", 'no_auxiliary'],
    ["Can't you sleep?", 'no_auxiliary'],
    ['Do your exercises.', 'statement'],
    ['Have a seat!', 'statement'],
    ['Are you tired? Do you want to sleep?', 'several_sentences'],
    ['Is Dr. Smith here?', 'several_sentences'],
    ['You tired?', 'no_auxiliary'],
    ['Want some water?', 'no_auxiliary'],
    ['Doing okay?', 'no_auxiliary'],
    ['Cannot wait?', 'no_auxiliary'],
    ['Must you go?', 'no_auxiliary'],
    ['Am I late?', 'no_auxiliary'],
    ['', 'empty'],
    ['   ', 'empty'],
];

describe('the yes or no classifier', () => {
    it('takes a question that begins with an auxiliary verb, and the smoke tag', () => {
        for (const question of POSITIVES) assert.equal(classifyYesNo(question).yesNo, true, `should be yes or no: ${JSON.stringify(question)}`);
        assert.equal(classifyYesNo('Smoke test: tea or coffee? [yes_no]').reason, 'smoke_tag');
        assert.equal(classifyYesNo('Are you tired?').reason, 'auxiliary');
    });

    it('leaves choices, wh-questions, statements, contractions and two questions to the planner', () => {
        for (const [question, reason] of NEGATIVES) {
            assert.deepEqual(classifyYesNo(question), { yesNo: false, reason }, `should go the normal way: ${JSON.stringify(question)}`);
        }
    });

    it('is deterministic: the same question always gets the same answer', () => {
        for (const question of [...POSITIVES, ...NEGATIVES.map(([q]) => q)]) assert.deepEqual(classifyYesNo(question), classifyYesNo(question));
    });
});

describe('the stock yes or no options', () => {
    it('are yes first and no second, replies, and pass the planner\'s own yes or no rules', () => {
        const options = stockYesNo();
        assert.deepEqual(
            options.map((o) => [o.kind, o.text, o.provenance, o.actionJson, o.sources.length, o.memoryRefs.length]),
            [
                ['reply', 'Yes.', 'stock', '', 0, 0],
                ['reply', 'No.', 'stock', '', 0, 0],
            ],
        );
        const plan = validatePlan(
            {
                answer_mode: 'yes_no',
                options: options.map((o) => ({ kind: 'reply' as const, text: o.text, tone: o.tone || 'neutral', laugh: o.laugh, sources: [], errand: null, call: null })),
            },
            { question: 'Are you tired?', origin: 'partner', menuItem: 'none', history: [], memory: [], web: [], forms: [], contacts: [], recentErrand: null, search: 'not_needed', maxOptions: 4, nowMs: 0, timeZone: 'UTC' },
        );
        assert.equal(plan.answerMode, 'yes_no');
    });

    it('are a fresh copy each time, so a caller cannot change the next question\'s options', () => {
        const first = stockYesNo();
        first[0]!.text = 'changed';
        assert.equal(stockYesNo()[0]?.text, 'Yes.');
    });
});

describe('the yes or no fast path', () => {
    it('publishes the stock Yes and No at once, final, with no memory, search or Claude', async () => {
        const h = start(harness({ yesNoFast: true }));
        const jobId = h.db.addOptionsJob({ questionText: 'Is the pharmacy on Bancroft still open?' });
        await waitFor(() => h.db.job(jobId)?.status === 'done', 3_000, 'job done');
        assert.equal(h.db.publishes.length, 1);
        const published = h.db.publishes[0];
        assert.equal(published?.final, true);
        assert.equal(published?.answerMode, 'yes_no');
        assert.deepEqual(published?.options.map((o) => o.text), ['Yes.', 'No.']);
        assert.equal(h.api.calls.length, 0, 'Claude is not asked');
        assert.equal(h.memory.recalls.length, 0, 'memory is not read');
        assert.equal(h.search.calls.length, 0, 'nothing is searched');
        assert.deepEqual(
            h.db.events.map((e) => [e.stage, e.status, e.detail]),
            [['plan', 'ok', 'yes no stock']],
        );
        assert.match(h.log.text(), /yes or no fast path: stock options job=\d+ why=auxiliary/);
    });

    it('takes the smoke tag too', async () => {
        const h = start(harness({ yesNoFast: true }));
        const jobId = h.db.addOptionsJob({ questionText: 'Smoke test: tea or coffee? [yes_no]' });
        await waitFor(() => h.db.job(jobId)?.status === 'done');
        assert.equal(h.db.publishes[0]?.answerMode, 'yes_no');
        assert.equal(h.api.calls.length, 0);
        assert.match(h.log.text(), /why=smoke_tag/);
    });

    it('leaves a choice to the planner and logs why', async () => {
        const h = start(harness({ yesNoFast: true }));
        h.api.reply(fourOptions());
        const jobId = h.db.addOptionsJob({ questionText: 'Do you want tea or coffee?' });
        await waitFor(() => h.db.job(jobId)?.status === 'done');
        assert.equal(h.api.calls.length, 1, 'Claude writes the options');
        assert.equal(h.db.publishes.at(-1)?.answerMode, 'pick');
        assert.ok(h.db.publishes.every((p) => p.options.every((o) => o.provenance !== 'stock')));
        assert.match(h.log.text(), /yes or no fast path not taken job=\d+ why=or_choice/);
    });

    it('never answers a menu turn with stock options', async () => {
        const h = start(harness({ yesNoFast: true }));
        h.api.reply(fourOptions());
        const jobId = h.db.addOptionsJob({ questionText: 'Do you need something?', origin: 'menu', menuItem: 'need' });
        await waitFor(() => h.db.job(jobId)?.status === 'done');
        assert.equal(h.api.calls.length, 1);
        assert.ok(h.db.publishes.every((p) => p.options.every((o) => o.provenance !== 'stock')));
    });

    it('is off unless it is turned on (the control)', async () => {
        const h = start(harness());
        h.api.reply(yesNo());
        const jobId = h.db.addOptionsJob({ questionText: 'Are you tired?' });
        await waitFor(() => h.db.job(jobId)?.status === 'done');
        assert.equal(h.api.calls.length, 1);
        assert.deepEqual(h.db.publishes[0]?.options.map((o) => o.text), ['Yes, a little tired.', 'No, I am fine.']);
    });

    it('fails the job like any refused publish when the module refuses the options', async () => {
        const h = start(harness({ yesNoFast: true }));
        h.db.failNext('agentPublishOptions', 'refused', { message: 'yes_no takes exactly 2 options' });
        const jobId = h.db.addOptionsJob({ questionText: 'Are you tired?' });
        await waitFor(() => h.db.job(jobId)?.status === 'failed');
        assert.equal(h.api.calls.length, 0);
        assert.equal(h.db.publishes.length, 0);
    });
});

/** Two pick replies; `sources` are the refs each one cites. */
function picks(texts: [string, string], sources: [string[], string[]] = [[], []]) {
    return {
        answer_mode: 'pick' as const,
        options: [reply({ text: texts[0], tone: 'warm', sources: sources[0] }), reply({ text: texts[1], tone: 'calm', sources: sources[1] })],
    };
}

const eventDetails = (h: Harness) => h.db.events.map((e) => `${e.stage} ${e.status} ${e.detail}`);

describe('draft first', () => {
    const LUNCH = 'Want to grab lunch nearby?';

    it('publishes Claude\'s options from memory while the search runs, then the options with web results', async () => {
        const h = start(harness({ draftFirst: true }));
        const release = h.search.hold();
        h.api.reply(picks(['Sure, somewhere quiet.', 'Not today.'], [['m1'], []]));
        h.api.reply(picks(['Yes, the cafe opens at 9.', 'Not today.'], [['w1'], []]));
        const jobId = h.db.addOptionsJob({ questionText: LUNCH });
        await waitFor(() => h.db.publishes.length === 1, 3_000, 'draft published');
        // The search has not answered yet: the first options do not wait for it.
        const first = h.db.publishes[0];
        assert.equal(first?.final, false, 'the draft keeps the job open');
        assert.equal(first?.answerMode, 'pick');
        assert.equal(first?.version, 1);
        assert.deepEqual(first?.options.map((o) => o.text), ['Sure, somewhere quiet.', 'Not today.']);
        assert.deepEqual(first?.options[0]?.memoryRefs, [memoryHit(1).id]);
        assert.ok(first?.options.every((o) => o.sources.length === 0), 'a draft cites no web source');
        assert.equal(h.search.calls.length, 1, 'the search is under way');
        assert.equal(h.web.indexed.size, 0, 'nothing from the web yet');
        assert.match(h.api.userMessage(0), /A web search is still running, so there are no outside facts yet\. Do not guess them\./);
        assert.match(h.api.userMessage(0), /Web results: none\./);
        assert.match(h.api.userMessage(0), /m1 \(past reply/);
        assert.equal(h.db.job(jobId)?.status, 'claimed');

        release();
        await waitFor(() => h.db.job(jobId)?.status === 'done', 3_000, 'job done');
        assert.equal(h.db.publishes.length, 2);
        const final = h.db.publishes[1];
        assert.equal(final?.final, true);
        assert.equal(final?.version, 2, 'a newer version, which the module switches in at the end of the pass');
        assert.equal(final?.options[0]?.sources[0]?.url, 'https://example.com/page-1');
        assert.match(h.api.userMessage(1), /w1 \(web page/);
        const draftEvent = h.db.events.find((e) => e.detail === 'claude draft' && e.status === 'ok');
        assert.equal(JSON.parse(draftEvent?.countsJson ?? '{}').draft, true);
        assert.ok(h.trace.indexOf('claude.create') < h.trace.indexOf('web.index'), `order was ${h.trace.steps.join(', ')}`);
        assert.equal(h.web.forgotten.length, 1, 'the web passages are still forgotten');
    });

    it('makes the draft the final options when the search brings nothing, with no second plan', async () => {
        const h = start(harness({ draftFirst: true }));
        const release = h.search.hold();
        h.search.error = new ApifyHttpError({ service: 'web-search', endpoint: 'POST /search', kind: 'timeout', status: null, attempts: 1 });
        h.api.reply(picks(['Sure, somewhere quiet.', 'Not today.']));
        const jobId = h.db.addOptionsJob({ questionText: LUNCH });
        await waitFor(() => h.db.publishes.length === 1, 3_000, 'draft published');
        release();
        await waitFor(() => h.db.job(jobId)?.status === 'done', 3_000, 'job done');
        assert.equal(h.api.calls.length, 1, 'Claude is asked once');
        assert.deepEqual(
            h.db.publishes.map((p) => [p.version, p.final, p.options.map((o) => o.text).join(' | ')]),
            [
                [1, false, 'Sure, somewhere quiet. | Not today.'],
                [2, true, 'Sure, somewhere quiet. | Not today.'],
            ],
        );
        assert.ok(eventDetails(h).includes('plan ok draft kept'));
    });

    it('makes a yes or no draft final at once and stops the search', async () => {
        const h = start(harness({ draftFirst: true }));
        h.search.hold();
        h.api.reply(yesNo());
        const jobId = h.db.addOptionsJob({ questionText: 'Is the pharmacy on Bancroft still open?' });
        await waitFor(() => h.db.job(jobId)?.status === 'done', 3_000, 'job done');
        assert.equal(h.db.publishes.length, 1, 'one version only: a second would start the prompt over');
        assert.equal(h.db.publishes[0]?.answerMode, 'yes_no');
        assert.equal(h.db.publishes[0]?.final, true);
        assert.equal(h.api.calls.length, 1);
        assert.equal(h.web.indexed.size, 0);
        const details = eventDetails(h);
        assert.ok(details.includes('search ok search stopped'), details.join(', '));
        assert.ok(details.indexOf('search ok search stopped') < details.length, 'the search step is closed');
    });

    it('does not draft when memory-first options were published', async () => {
        const h = start(harness({ draftFirst: true }));
        h.memory.recallResult = {
            hits: [memoryHit(1, { reply: 'Sure, somewhere quiet.' }), memoryHit(2, { reply: 'Not today.' })],
            instant: ['Sure, somewhere quiet.', 'Not today.'],
            mossMs: 2,
            wallMs: 3,
        };
        h.api.reply(fourOptions());
        const jobId = h.db.addOptionsJob({ questionText: LUNCH });
        await waitFor(() => h.db.job(jobId)?.status === 'done');
        assert.equal(h.api.calls.length, 1, 'no draft plan');
        assert.deepEqual(h.db.publishes.map((p) => [p.final, p.options[0]?.provenance]), [
            [false, 'memory'],
            [true, 'model'],
        ]);
    });

    it('does not draft a question that is not searched', async () => {
        const h = start(harness({ draftFirst: true }));
        h.api.reply(yesNo());
        const jobId = h.db.addOptionsJob({ questionText: 'Are you tired?' });
        await waitFor(() => h.db.job(jobId)?.status === 'done');
        assert.equal(h.api.calls.length, 1);
        assert.equal(h.db.publishes.length, 1);
        assert.ok(!eventDetails(h).some((d) => d.includes('draft')));
    });

    it('is off unless it is turned on (the control): nothing is published while the search runs', async () => {
        const h = start(harness());
        const release = h.search.hold();
        h.api.reply(fourOptions());
        const jobId = h.db.addOptionsJob({ questionText: LUNCH });
        await waitFor(() => h.search.calls.length === 1, 3_000, 'search started');
        await settle(50);
        assert.equal(h.db.publishes.length, 0);
        assert.equal(h.api.calls.length, 0);
        release();
        await waitFor(() => h.db.job(jobId)?.status === 'done');
        assert.equal(h.db.publishes.length, 1);
    });

    it('does not publish a draft that used memory once memory consent is withdrawn, and the final options leave memory out', async () => {
        const h = start(harness({ draftFirst: true }));
        const release = h.search.hold();
        h.api.replyWith(() => {
            // Revoked while Claude writes the draft.
            h.db.revokeConsent('memory');
            return picks(['Sure, somewhere quiet.', 'Not today.'], [['m1'], []]);
        });
        h.api.reply(picks(['Yes, the cafe opens at 9.', 'Not today.'], [['w1'], []]));
        const jobId = h.db.addOptionsJob({ questionText: LUNCH });
        await waitFor(() => h.api.calls.length === 1, 3_000, 'draft asked');
        await settle(30);
        release();
        await waitFor(() => h.db.job(jobId)?.status === 'done', 3_000, 'job done');
        assert.equal(h.db.publishes.length, 1, 'the draft was not published');
        assert.equal(h.db.publishes[0]?.final, true);
        assert.ok(h.db.publishes[0]?.options.every((o) => o.memoryRefs.length === 0 && o.provenance !== 'memory'));
        assert.match(h.api.userMessage(1), /Memory items: none\./);
        assert.match(h.log.text(), /no draft options; the options come after the search .*why=ConsentWithdrawnError/);
    });

    it('offers no call in a draft', async () => {
        const h = start(harness({ draftFirst: true, contacts: [LEON] }));
        const release = h.search.hold();
        h.api.reply(picks(['Sure.', 'Not today.']));
        h.api.reply(picks(['Yes, the cafe opens at 9.', 'Not today.'], [['w1'], []]));
        const jobId = h.db.addOptionsJob({ questionText: LUNCH, recentErrandTitle: 'Care team request', recentErrandSentAtMs: Date.now() - 30_000 });
        await waitFor(() => h.db.publishes.length === 1, 3_000, 'draft published');
        assert.match(h.api.userMessage(0), /Contacts for a call: none, so no call options\./);
        release();
        await waitFor(() => h.db.job(jobId)?.status === 'done');
        assert.match(h.api.userMessage(1), /Contacts for a call:\n/);
    });

    it('still ends with the options when the draft\'s planner call fails', async () => {
        const h = start(harness({ draftFirst: true }));
        const release = h.search.hold();
        h.api.reply({ answer_mode: 'pick', options: [] });
        h.api.reply(fourOptions());
        const jobId = h.db.addOptionsJob({ questionText: LUNCH });
        await waitFor(() => h.api.calls.length === 1, 3_000, 'draft asked');
        await settle(30);
        release();
        await waitFor(() => h.db.job(jobId)?.status === 'done', 3_000, 'job done');
        assert.equal(h.db.publishes.length, 1);
        assert.equal(h.db.publishes[0]?.final, true);
        assert.ok(eventDetails(h).includes('plan error claude invalid reply'));
    });
});

describe('the speed settings', () => {
    const base = { ANTHROPIC_API_KEY: 'k' };
    const tokenFile = join(tmpdir(), 'neurolingo-agent-test-speed-token');

    it('turns the yes or no fast path on by default, and off with AGENT_YES_NO_FAST=off', () => {
        assert.equal(readConfig(base, tokenFile).config.speed.yesNoFast, true);
        assert.equal(readConfig({ ...base, AGENT_YES_NO_FAST: 'off' }, tokenFile).config.speed.yesNoFast, false);
        const bad = readConfig({ ...base, AGENT_YES_NO_FAST: 'maybe' }, tokenFile);
        assert.ok(bad.problems.includes('AGENT_YES_NO_FAST must be on or off.'));
    });

    it('turns draft first on by default, and off with AGENT_DRAFT_FIRST=off', () => {
        assert.equal(readConfig(base, tokenFile).config.speed.draftFirst, true);
        assert.equal(readConfig({ ...base, AGENT_DRAFT_FIRST: 'off' }, tokenFile).config.speed.draftFirst, false);
    });
});
