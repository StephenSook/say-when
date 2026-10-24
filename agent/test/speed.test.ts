// The speed changes: the yes or no fast path (src/fastpath.ts).

import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { readConfig } from '../src/config.js';
import { classifyYesNo, stockYesNo } from '../src/fastpath.js';
import { validatePlan } from '../src/planner/validate.js';
import { fourOptions, harness, waitFor, yesNo, type Harness } from './helpers.js';

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

describe('the speed settings', () => {
    const base = { ANTHROPIC_API_KEY: 'k' };
    const tokenFile = join(tmpdir(), 'neurolingo-agent-test-speed-token');

    it('turns the yes or no fast path on by default, and off with AGENT_YES_NO_FAST=off', () => {
        assert.equal(readConfig(base, tokenFile).config.speed.yesNoFast, true);
        assert.equal(readConfig({ ...base, AGENT_YES_NO_FAST: 'off' }, tokenFile).config.speed.yesNoFast, false);
        const bad = readConfig({ ...base, AGENT_YES_NO_FAST: 'maybe' }, tokenFile);
        assert.ok(bad.problems.includes('AGENT_YES_NO_FAST must be on or off.'));
    });
});
