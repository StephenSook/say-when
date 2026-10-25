// PLAN D27: a planner reply is mended where the code can (src/planner/repair.ts), then sent back once with its broken
// rules named, and every invalid reply is logged by rule name only.

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import Anthropic from '@anthropic-ai/sdk';

import { recordingLogger } from '../src/log.js';
import { buildOptions } from '../src/options.js';
import { ClaudePlanner } from '../src/planner/claude.js';
import { repairReply } from '../src/planner/repair.js';
import type { PlanReply } from '../src/planner/schema.js';
import { PlannerError, type PlanInput } from '../src/planner/types.js';
import { TEXT_MAX_WORDS, validatePlan } from '../src/planner/validate.js';
import { DEMO_FORM, FakeApi, fourOptions, harness, reply, waitFor, type Harness } from './helpers.js';

let open: Harness | null = null;
afterEach(async () => {
    await open?.orchestrator.stop(1_000);
    open = null;
});

function input(overrides: Partial<PlanInput> = {}): PlanInput {
    return {
        question: 'Want to grab lunch after this?',
        origin: 'partner',
        menuItem: 'none',
        history: [],
        memory: [],
        web: [
            {
                ref: 'w1',
                kind: 'web',
                title: 'Cafe Strada',
                text: 'Coffee shop.',
                score: 0.8,
                source: { source: 'web', url: 'https://example.com/strada', placeId: undefined, fetchedAt: '2026-10-24T19:00:00.000Z' },
            },
        ],
        forms: [],
        contacts: [],
        recentErrand: null,
        search: 'done',
        maxOptions: 4,
        nowMs: Date.parse('2026-10-25T09:20:00Z'),
        timeZone: 'America/Los_Angeles',
        ...overrides,
    };
}

const signal = () => new AbortController().signal;
const single = (): PlanReply => ({ answer_mode: 'pick', options: [reply({ text: 'The museum is open.', tone: 'calm' })] });

describe('the planner reply repair (D27)', () => {
    it('cuts a four-option reply to three under AGENT_MAX_OPTIONS=3, with Search the web at rank 3', async () => {
        const h = harness({ direct: true });
        h.deps.maxOptions = 3;
        open = h;
        h.orchestrator.start();
        h.api.reply({
            answer_mode: 'pick',
            options: [
                reply({ label: 'Sure', text: 'Sure, I would love to go out.', tone: 'warm' }),
                reply({ label: 'Not today', text: 'Not today, I am tired.', tone: 'calm' }),
                reply({ kind: 'search', label: 'Search the web', text: 'Search the web for ideas.', tone: 'neutral' }),
                reply({ label: 'You pick', text: 'You pick, I am easy.', tone: 'firm' }),
            ],
        });
        const jobId = h.db.addOptionsJob({ questionText: 'Anything you want to do today in San Francisco?' });
        await waitFor(() => h.db.job(jobId)?.status === 'done');
        const published = h.db.publishes.find((p) => p.final);
        assert.deepEqual(published?.options.map((o) => [o.kind, o.label]), [
            ['reply', 'Sure'],
            ['reply', 'Not today'],
            ['search', 'Search the web'],
        ]);
        assert.equal(h.api.calls.length, 1, 'no second call');
        const repaired = h.log.entries.find((e) => e.message === 'planner reply repaired');
        assert.equal(repaired?.fields.fixes, 'drop_search_over_limit');
        assert.equal(repaired?.fields.attempt, 1);
    });

    it('gives a repeated tone the next unused one, and keeps only the first laugh', async () => {
        const api = new FakeApi().reply({
            answer_mode: 'pick',
            options: [
                reply({ text: 'Sure, let us go.', tone: 'warm', laugh: true }),
                reply({ text: 'Maybe later.', tone: 'warm', laugh: true }),
                reply({ text: 'Not today.', tone: 'warm' }),
            ],
        });
        const result = await new ClaudePlanner({ api }).plan(input(), signal());
        assert.deepEqual(
            result.options.map((o) => o.tone),
            ['warm', 'sad', 'firm'],
        );
        assert.deepEqual(
            result.options.map((o) => o.laugh),
            [true, false, false],
        );
        assert.equal(api.calls.length, 1);
    });

    it('drops a source id that was never given and keeps the option', async () => {
        const api = new FakeApi().reply(fourOptions([['w9', 'w1'], ['m7'], [], []]));
        const result = await new ClaudePlanner({ api }).plan(input(), signal());
        assert.equal(result.options.length, 4);
        assert.deepEqual(result.options[0]?.refs, ['w1']);
        assert.deepEqual(result.options[1]?.refs, []);
        assert.equal(api.calls.length, 1);
    });

    it('drops an option that repeats an earlier text, and the sidecar fills the pick back up to two (D22)', async () => {
        const api = new FakeApi().reply({ answer_mode: 'pick', options: [reply({ text: 'Sure.', tone: 'warm' }), reply({ text: ' sure. ', tone: 'calm' })] });
        const result = await new ClaudePlanner({ api }).plan(input(), signal());
        assert.equal(result.options.length, 1);
        assert.equal(api.calls.length, 1);
        const built = buildOptions(result, [], [], () => null);
        assert.deepEqual(
            built.options.map((o) => o.provenance),
            ['model', 'stock'],
        );
    });

    it('cuts a long text at a word boundary within the limits', () => {
        const long = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ');
        const { reply: fixed, fixes } = repairReply({ answer_mode: 'pick', options: [reply({ text: long, tone: 'warm' }), reply({ text: 'No.', tone: 'calm' })] }, input());
        assert.deepEqual(fixes, ['trim_text']);
        const text = fixed.options[0]?.text ?? '';
        assert.equal(text.split(' ').length, TEXT_MAX_WORDS);
        assert.ok(long.startsWith(text.replace(/\.$/, '')));
        assert.doesNotThrow(() => validatePlan(fixed, input()));
    });

    it('keeps the errand option and the first replies when there are too many', () => {
        const errand = reply({
            text: 'Send the care team a ride request.',
            kind: 'errand',
            tone: 'firm',
            errand: { form_key: 'care_team_request', fields: [{ label: 'What do you need?', value: 'Ride' }] },
        });
        const many: PlanReply = {
            answer_mode: 'pick',
            options: [reply({ text: 'One.', tone: 'warm' }), reply({ text: 'Two.', tone: 'calm' }), reply({ text: 'Three.', tone: 'neutral' }), errand],
        };
        const given = input({ maxOptions: 3, forms: [DEMO_FORM] });
        const { reply: fixed, fixes } = repairReply(many, given);
        assert.deepEqual(fixes, ['drop_over_limit']);
        assert.deepEqual(
            fixed.options.map((o) => o.text),
            ['One.', 'Two.', 'Send the care team a ride request.'],
        );
        assert.doesNotThrow(() => validatePlan(fixed, given));
    });
});

describe('the one retry after an invalid reply (D27)', () => {
    it('sends an unrepairable reply back once, naming the broken rules, then fails as before', async () => {
        const log = recordingLogger();
        const api = new FakeApi().reply(single()).reply(single());
        await assert.rejects(
            new ClaudePlanner({ api, log }).plan(input(), signal()),
            (e: unknown) => e instanceof PlannerError && e.code === 'invalid_reply' && e.problems.includes('option_count'),
        );
        assert.equal(api.calls.length, 2, 'exactly one retry');
        assert.doesNotMatch(api.userMessage(0), /Your last reply broke/);
        assert.match(api.userMessage(1), /Your last reply broke these rules: option_count\. Return at least 2 and at most 4 options\./);
        assert.deepEqual(
            log.entries.filter((e) => e.message === 'planner reply invalid').map((e) => [e.fields.problems, e.fields.attempt]),
            [
                ['option_count', 1],
                ['option_count', 2],
            ],
        );
    });

    it('takes the retry when it comes back valid', async () => {
        const api = new FakeApi().reply(single()).reply(fourOptions());
        const result = await new ClaudePlanner({ api }).plan(input(), signal());
        assert.equal(result.attempts, 2);
        assert.equal(result.options.length, 4);
    });

    it('shares one budget of two calls with the transient retry', async () => {
        const api = new FakeApi().fail(new Anthropic.APIConnectionTimeoutError()).reply(single()).reply(fourOptions());
        await assert.rejects(new ClaudePlanner({ api, sleep: async () => undefined }).plan(input(), signal()), (e: unknown) => e instanceof PlannerError && e.code === 'invalid_reply');
        assert.equal(api.calls.length, 2);
    });

    it('fails on the reply when the retry call itself fails', async () => {
        const log = recordingLogger();
        const api = new FakeApi().reply(single()).fail(new Anthropic.APIConnectionTimeoutError());
        await assert.rejects(new ClaudePlanner({ api, log }).plan(input(), signal()), (e: unknown) => e instanceof PlannerError && e.code === 'invalid_reply');
        assert.equal(api.calls.length, 2);
        assert.ok(log.entries.some((e) => e.message === 'planner retry failed' && e.fields.code === 'timeout'));
    });

    it('logs the broken rules by name, never the reply text', async () => {
        const log = recordingLogger();
        const secret = 'Zorbleton Quixby';
        const bad: PlanReply = {
            answer_mode: 'yes_no',
            options: [reply({ text: `Yes ${secret}.`, tone: 'warm' }), reply({ text: `No ${secret}.`, tone: 'calm' }), reply({ text: `Maybe ${secret}.`, tone: 'firm' })],
        };
        const api = new FakeApi().reply(bad).reply(bad);
        await assert.rejects(new ClaudePlanner({ api, log }).plan(input(), signal()));
        const entry = log.entries.find((e) => e.message === 'planner reply invalid');
        assert.equal(entry?.fields.problems, 'yes_no_needs_two');
        assert.equal(entry?.fields.attempt, 1);
        assert.doesNotMatch(log.text(), /Zorbleton|Quixby/);
    });
});
