import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import Anthropic from '@anthropic-ai/sdk';

import { ClaudePlanner, DEFAULT_PLANNER_MODEL } from '../src/planner/claude.js';
import { buildUserMessage, SYSTEM_PROMPT } from '../src/planner/prompt.js';
import { PlannerError, type PlanInput } from '../src/planner/types.js';
import { validatePlan } from '../src/planner/validate.js';
import { DEMO_FORM, FakeApi, fourOptions, LEON, message, reply, yesNo } from './helpers.js';

function input(overrides: Partial<PlanInput> = {}): PlanInput {
    return {
        question: 'Want to grab lunch after this?',
        origin: 'partner',
        menuItem: 'none',
        history: [],
        memory: [{ ref: 'm1', id: 'mem:reply:aaaaaaaaaaaaaaaa', type: 'reply', text: 'Q: Lunch?\nA: Somewhere quiet.', savedAtMs: Date.parse('2026-10-12T18:00:00Z') }],
        web: [
            {
                ref: 'w1',
                kind: 'maps',
                title: 'Cafe Strada',
                text: 'Coffee shop. Open when checked.',
                score: 0.82,
                source: { source: 'maps', url: 'https://maps.example.com/?cid=1', placeId: 'place1', fetchedAt: '2026-10-24T19:00:00.000Z' },
            },
        ],
        forms: [],
        contacts: [],
        recentErrand: null,
        search: 'done',
        maxOptions: 4,
        nowMs: Date.parse('2026-10-24T20:05:00Z'),
        timeZone: 'America/Los_Angeles',
        ...overrides,
    };
}

const signal = () => new AbortController().signal;

describe('the planner request', () => {
    it('defaults to a fast current model with structured output, low effort and no sampling parameters', () => {
        const planner = new ClaudePlanner({ api: new FakeApi() });
        const params = planner.request(input());
        assert.equal(DEFAULT_PLANNER_MODEL, 'claude-haiku-5-5');
        assert.equal(params.model, 'claude-haiku-5-5');
        assert.equal(params.output_config?.effort, 'low');
        assert.equal(params.output_config?.format?.type, 'json_schema');
        const schema = params.output_config?.format?.schema as Record<string, unknown>;
        assert.equal(schema.additionalProperties, false);
        assert.ok(params.max_tokens >= 4000, 'room for adaptive thinking plus the reply');
        for (const key of ['temperature', 'top_p', 'top_k', 'thinking', 'fallbacks', 'betas']) assert.equal(key in params, false, key);
    });

    it('opts into the server-side refusal fallback only for models that support it', () => {
        const opus = new ClaudePlanner({ api: new FakeApi(), model: 'claude-opus-5-5' }).request(input());
        assert.deepEqual(opus.betas, ['server-side-fallback-2026-07-01']);
        assert.equal(opus.fallbacks, 'default');
        const haiku = new ClaudePlanner({ api: new FakeApi(), model: 'claude-haiku-5-5' }).request(input());
        assert.equal(haiku.fallbacks, undefined);
    });

    it('keeps the system prompt fixed and puts everything that varies in the user message', () => {
        const params = new ClaudePlanner({ api: new FakeApi() }).request(input());
        const system = params.system as { type: string; text: string; cache_control?: unknown }[];
        assert.equal(system[0]?.text, SYSTEM_PROMPT);
        assert.deepEqual(system[0]?.cache_control, { type: 'ephemeral' });
        const user = buildUserMessage(input());
        assert.match(user, /The partner asked: "Want to grab lunch after this\?"/);
        assert.match(user, /^m1 \(past reply, saved Oct 12\)/m);
        assert.match(user, /^w1 \(place, checked 12:00 PM\)/m);
        assert.match(user, /Write at most 4 options\./);
        assert.doesNotMatch(SYSTEM_PROMPT, /\d{4}-\d{2}-\d{2}/);
    });

    it('asks for menu items in the menu wording and lists forms and contacts only when allowed', () => {
        const menu = buildUserMessage(input({ origin: 'menu', menuItem: 'request', forms: [DEMO_FORM] }));
        assert.match(menu, /picked "Send a request"/);
        assert.match(menu, /care_team_request "Care team request":/);
        assert.match(menu, /"Who is this from\?" fixed/);
        assert.match(menu, /"What do you need\?" one of: Ride, Meal or drink, Company, Something else \(required\)/);
        assert.match(menu, /Contacts for a call: none/);
        const call = buildUserMessage(input({ contacts: [LEON], recentErrand: { title: 'Care team request', sentAtMs: Date.parse('2026-10-24T20:00:00Z') } }));
        assert.match(call, /^leon: Leonora$/m);
        assert.match(call, /Recent request: "Care team request", sent at 1:00 PM\./);
    });
});

describe('the planner reply', () => {
    it('returns up to four options with distinct tones and their sources', async () => {
        const api = new FakeApi().reply(fourOptions([['w1'], ['m1'], [], ['w1', 'm1', 'w1']]));
        const result = await new ClaudePlanner({ api }).plan(input(), signal());
        assert.equal(result.answerMode, 'pick');
        assert.equal(result.options.length, 4);
        assert.equal(new Set(result.options.map((o) => o.tone)).size, 4);
        assert.deepEqual(result.options[3]?.refs, ['w1', 'm1']);
        assert.equal(result.attempts, 1);
        assert.equal(result.cacheReadTokens, 640);
        assert.equal(result.model, 'claude-haiku-5-5');
        assert.equal(api.calls[0]?.options?.maxRetries, 0);
    });

    it('accepts a yes or no question as exactly two replies, yes first', async () => {
        const result = await new ClaudePlanner({ api: new FakeApi().reply(yesNo()) }).plan(input({ question: 'Are you tired?' }), signal());
        assert.equal(result.answerMode, 'yes_no');
        assert.deepEqual(
            result.options.map((o) => o.text),
            ['Yes, a little tired.', 'No, I am fine.'],
        );
    });

    const invalid: [string, ReturnType<typeof fourOptions>, string][] = [
        ['three options in yes_no', { answer_mode: 'yes_no', options: fourOptions().options.slice(0, 3) }, 'yes_no_needs_two'],
        ['five options', { answer_mode: 'pick', options: [...fourOptions().options, reply({ text: 'Fifth.', tone: 'sad' })] }, 'option_count'],
        ['no options', { answer_mode: 'pick', options: [] }, 'option_count'],
        ['a single answer (PLAN D22)', { answer_mode: 'pick', options: [reply({ text: 'The museum is open.', tone: 'calm' })] }, 'option_count'],
        ['two options with one tone', { answer_mode: 'pick', options: [reply({ text: 'A.', tone: 'warm' }), reply({ text: 'B.', tone: 'warm' })] }, 'duplicate_tone'],
        ['a source that was never given', fourOptions([['w9'], [], [], []]), 'unknown_source'],
        ['the same text twice', { answer_mode: 'pick', options: [reply({ text: 'Sure.', tone: 'warm' }), reply({ text: ' sure. ', tone: 'calm' })] }, 'duplicate_text'],
        ['markup in the text', { answer_mode: 'pick', options: [reply({ text: 'Yes [laughter]', tone: 'warm' })] }, 'markup_in_text'],
        ['a yes answer that starts with no', { answer_mode: 'yes_no', options: [reply({ text: 'No, not really.', tone: 'calm' }), reply({ text: 'Yes.', tone: 'warm' })] }, 'yes_answer_starts_with_no'],
        ['an errand as the only option', { answer_mode: 'pick', options: [reply({ text: 'Send it.', kind: 'errand', tone: 'warm', errand: { form_key: 'care_team_request', fields: [{ label: 'What do you need?', value: 'Ride' }] } })] }, 'only_actions'],
        ['an errand for a form that is not allowed', { answer_mode: 'pick', options: [reply({ text: 'Ok.', tone: 'calm' }), reply({ text: 'Send it.', kind: 'errand', tone: 'warm', errand: { form_key: 'other_form', fields: [] } })] }, 'unknown_form'],
        ['a call to someone not on the list', { answer_mode: 'pick', options: [reply({ text: 'Ok.', tone: 'calm' }), reply({ text: 'Call Sam.', kind: 'call', tone: 'warm', call: { contact_id: 'sam' } })] }, 'unknown_contact'],
        ['an errand in yes_no mode', { answer_mode: 'yes_no', options: [reply({ text: 'Yes.', tone: 'calm' }), reply({ text: 'Send it.', kind: 'errand', tone: 'warm', errand: { form_key: 'care_team_request', fields: [] } })] }, 'action_in_yes_no'],
        ['a reply carrying an action', { answer_mode: 'pick', options: [reply({ text: 'Ok.', tone: 'calm', call: { contact_id: 'leon' } })] }, 'reply_with_action'],
        ['two laughs', { answer_mode: 'pick', options: [reply({ text: 'Ha.', tone: 'calm', laugh: true }), reply({ text: 'Heh.', tone: 'warm', laugh: true })] }, 'more_than_one_laugh'],
    ];
    for (const [name, bad, problem] of invalid) {
        it(`refuses ${name}`, () => {
            assert.throws(
                () => validatePlan(bad, input({ forms: [DEMO_FORM], contacts: [LEON], recentErrand: { title: 'Care team request', sentAtMs: Date.now() } })),
                (error: unknown) => error instanceof PlannerError && error.code === 'invalid_reply' && error.problems.includes(problem),
            );
        });
    }

    it('fills an errand from the form: fixed values in, choices normalized, unknown labels refused', () => {
        const plan = validatePlan(
            {
                answer_mode: 'pick',
                options: [
                    reply({ text: 'Nothing else for now.', tone: 'calm' }),
                    reply({
                        text: 'Send the care team a lunch request.',
                        kind: 'errand',
                        tone: 'warm',
                        errand: { form_key: 'care_team_request', fields: [{ label: 'what do you need?', value: 'meal or drink' }, { label: 'Details', value: 'Lunch at noon' }] },
                    }),
                ],
            },
            input({ forms: [DEMO_FORM] }),
        );
        assert.deepEqual(plan.options[1]?.errand?.fields, [
            { label: 'Who is this from?', value: 'Alex', source: 'profile' },
            { label: 'What do you need?', value: 'Meal or drink', source: 'conversation' },
            { label: 'Details', value: 'Lunch at noon', source: 'conversation' },
        ]);
        const missing = { answer_mode: 'pick' as const, options: [reply({ text: 'No.', tone: 'calm' }), reply({ text: 'Send.', kind: 'errand', tone: 'warm', errand: { form_key: 'care_team_request', fields: [{ label: 'Details', value: 'x' }] } })] };
        assert.throws(() => validatePlan(missing, input({ forms: [DEMO_FORM] })), (e: unknown) => e instanceof PlannerError && e.problems.includes('missing_required_field'));
        const badChoice = { answer_mode: 'pick' as const, options: [reply({ text: 'No.', tone: 'calm' }), reply({ text: 'Send.', kind: 'errand', tone: 'warm', errand: { form_key: 'care_team_request', fields: [{ label: 'What do you need?', value: 'Pizza' }] } })] };
        assert.throws(() => validatePlan(badChoice, input({ forms: [DEMO_FORM] })), (e: unknown) => e instanceof PlannerError && e.problems.includes('bad_choice'));
    });

    it('offers a call only with a recent errand', () => {
        const callPlan = { answer_mode: 'pick' as const, options: [reply({ text: 'Not now.', tone: 'calm' }), reply({ text: 'Call Leonora about it.', kind: 'call', tone: 'warm', call: { contact_id: 'leon' } })] };
        assert.throws(() => validatePlan(callPlan, input({ contacts: [LEON], recentErrand: null })), (e: unknown) => e instanceof PlannerError && e.problems.includes('call_without_recent_errand'));
        const ok = validatePlan(callPlan, input({ contacts: [LEON], recentErrand: { title: 'Care team request', sentAtMs: Date.now() } }));
        assert.equal(ok.options[1]?.call?.contact.contactId, 'leon');
    });
});

describe('planner errors and retries', () => {
    it('retries once on a transient error, then succeeds', async () => {
        const api = new FakeApi().fail(new Anthropic.APIConnectionTimeoutError()).reply(fourOptions());
        const result = await new ClaudePlanner({ api, sleep: async () => undefined }).plan(input(), signal());
        assert.equal(result.attempts, 2);
        assert.equal(api.calls.length, 2);
    });

    it('gives up after one retry with a clear code', async () => {
        const api = new FakeApi().fail(new Anthropic.InternalServerError(529, undefined, 'overloaded', new Headers())).fail(new Anthropic.InternalServerError(529, undefined, 'overloaded', new Headers()));
        await assert.rejects(new ClaudePlanner({ api, sleep: async () => undefined }).plan(input(), signal()), (e: unknown) => e instanceof PlannerError && e.code === 'overloaded');
        assert.equal(api.calls.length, 2);
    });

    it('never retries a request the API refused', async () => {
        const api = new FakeApi().fail(new Anthropic.BadRequestError(400, undefined, 'bad', new Headers())).reply(fourOptions());
        await assert.rejects(new ClaudePlanner({ api }).plan(input(), signal()), (e: unknown) => e instanceof PlannerError && e.code === 'bad_request');
        assert.equal(api.calls.length, 1);
    });

    it('does not wait out a long Retry-After', async () => {
        const api = new FakeApi().fail(new Anthropic.RateLimitError(429, undefined, 'slow down', new Headers({ 'retry-after': '30' }))).reply(fourOptions());
        await assert.rejects(new ClaudePlanner({ api }).plan(input(), signal()), (e: unknown) => e instanceof PlannerError && e.code === 'rate_limited');
        assert.equal(api.calls.length, 1);
    });

    it('reads the stop reason before the reply: refusal and cut-off replies are their own errors', async () => {
        const refused = new FakeApi().raw(message('{}', { stop_reason: 'refusal' }));
        await assert.rejects(new ClaudePlanner({ api: refused }).plan(input(), signal()), (e: unknown) => e instanceof PlannerError && e.code === 'refused');
        const cut = new FakeApi().raw(message('{"answer_mode":"pi', { stop_reason: 'max_tokens' }));
        await assert.rejects(new ClaudePlanner({ api: cut }).plan(input(), signal()), (e: unknown) => e instanceof PlannerError && e.code === 'truncated');
    });

    it('refuses a reply that does not match the schema, without quoting it', async () => {
        const api = new FakeApi().raw(message('{"answer_mode":"maybe","options":"OPTIONTEXT"}'));
        await assert.rejects(new ClaudePlanner({ api }).plan(input(), signal()), (e: unknown) => {
            assert.ok(e instanceof PlannerError);
            assert.equal(e.code, 'invalid_reply');
            assert.doesNotMatch(e.message, /OPTIONTEXT/);
            return true;
        });
    });

    it('stops without a retry when the job is cancelled', async () => {
        const api = new FakeApi();
        api.hang = true;
        const controller = new AbortController();
        const pending = new ClaudePlanner({ api }).plan(input(), controller.signal);
        controller.abort();
        await assert.rejects(pending, (e: unknown) => e instanceof PlannerError && e.code === 'aborted');
        assert.equal(api.calls.length, 1);
    });
});
