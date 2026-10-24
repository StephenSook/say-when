import './no-network.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    deleteCallData,
    Dialer,
    insideCallingHours,
    parseConsentList,
    parseDoNotCall,
    REFUSALS,
    type CallSnapshot,
    type DialerConfig,
} from '../src/call.js';
import { checkAgentScript, loadAgentScript, renderTemplate } from '../src/call-script.js';
import type { PipelineEvent } from '../src/events.js';
import { isEmergencyNumber, spokenNumber, toUsE164 } from '../src/phone.js';
import { fakeFetch, type FakeAnswer, type FetchCall } from './fakes.js';

const KEY = 'sk_car_call_key_42';
// 555-01XX numbers are reserved for fiction, so these can never reach a real phone.
const LEON = '+14155550123';
const CALLBACK = '+14155550188';
const VOICE = 'db6b0ed5-d5d3-463d-ae85-518a07d3c2b4';
const script = loadAgentScript();
// 11:00 AM Pacific Daylight Time on Saturday, October 24, 2026.
const MORNING = Date.parse('2026-10-24T18:00:00Z');

const consentFor = (extra: Record<string, unknown> = {}) =>
    JSON.stringify([
        {
            id: 'leon',
            name: 'Leon',
            phone: LEON,
            consentText: 'I agree to AI-voice calls from the Say When demo during Cal Hacks 13, recorded and transcribed by Cartesia.',
            consentedAt: '2026-10-23T16:00:00Z',
            ...extra,
        },
    ]);

function publishedAgent(overrides: Record<string, unknown> = {}) {
    return {
        id: 'agent_test',
        name: 'Care team caller',
        config: {
            initial_message: script.welcome,
            instructions: script.instructions,
            system_tools: { voicemail_detection: { description: null, pre_tool_speech: 'off', message: null } },
            audio: { output: { voice_id: VOICE } },
            ...overrides,
        },
    };
}

interface Scenario {
    statuses?: Record<string, unknown>[];
    agent?: unknown;
    voice?: Record<string, unknown>;
    dial?: (call: FetchCall) => FakeAnswer | Promise<FakeAnswer>;
    cancelStatus?: number;
}

function harness(options: { now?: number; scenario?: Scenario; dnc?: string[]; consent?: string; config?: Partial<DialerConfig> } = {}) {
    const clock = { t: options.now ?? MORNING };
    const events: PipelineEvent[] = [];
    const updates: CallSnapshot[] = [];
    const optOuts: string[] = [];
    const sleeps: number[] = [];
    const scenario = options.scenario ?? {};
    const statuses = [
        ...(scenario.statuses ?? [{ status: 'created' }, { status: 'started' }, { status: 'completed', end_reason: 'agent_hangup', summary: 'Leon got it.' }]),
    ];
    let last: Record<string, unknown> = { status: 'created' };
    const fetch = fakeFetch(async (call) => {
        const url = new URL(call.url);
        if (call.method === 'GET' && url.pathname === '/v1/agents/agent_test') return { status: 200, body: scenario.agent ?? publishedAgent() };
        if (call.method === 'GET' && url.pathname === '/voices') {
            return { status: 200, body: { data: [{ id: VOICE, name: 'Skylar', is_owner: false, is_pro: false, status: 'active', ...scenario.voice }], has_more: false } };
        }
        if (call.method === 'POST' && url.pathname === '/agents/calls') {
            return scenario.dial ? scenario.dial(call) : { status: 200, body: { calls: [{ number: LEON, agent_call_id: 'ac_test' }] } };
        }
        if (call.method === 'GET' && url.pathname === '/agents/calls/ac_test') {
            last = statuses.shift() ?? last;
            return { status: 200, body: { id: 'ac_test', agent_id: 'agent_test', agent_version_id: 'av_1', zdr_enabled: false, ...last } };
        }
        if (call.method === 'POST' && url.pathname === '/agents/calls/ac_test/cancel') {
            const status = scenario.cancelStatus ?? 200;
            if (status === 200) statuses.splice(0, statuses.length, { status: 'completed', end_reason: 'api_cancelled' });
            return { status, body: status === 200 ? { cancelled: true } : { title: 'Not active', message: 'not active', request_id: 'r' } };
        }
        return { status: 404, body: { title: 'Not found', message: 'no route', request_id: 'r' } };
    });
    const lists = { consent: parseConsentList(options.consent ?? consentFor(), clock.t), doNotCall: new Set(options.dnc ?? []) };
    const dialer = new Dialer(
        { apiKey: KEY, agentId: 'agent_test', fromNumberId: 'ap_test', callbackNumber: CALLBACK, personName: 'Shashank', script, ...options.config },
        lists,
        {
            fetch,
            now: () => clock.t,
            sleep: async (ms) => {
                sleeps.push(ms);
                clock.t += ms;
            },
            onEvent: (event) => events.push(event),
            onUpdate: (snapshot) => updates.push(snapshot),
            onDoNotCall: (number) => optOuts.push(number),
        },
    );
    return { dialer, fetch, clock, events, updates, optOuts, sleeps };
}

const request = (clock: { t: number }, extra: Record<string, unknown> = {}) => ({
    requestId: 'call_1',
    contactId: 'leon',
    errand: { title: 'Care team request', sentAt: clock.t - 60_000 },
    ...extra,
});

const count = (calls: FetchCall[], method: string, suffix: string) => calls.filter((c) => c.method === method && new URL(c.url).pathname.endsWith(suffix)).length;

function prepareAndPlace(h: ReturnType<typeof harness>, extra: Record<string, unknown> = {}) {
    const prepared = h.dialer.prepare(request(h.clock, extra));
    assert.ok(prepared.ok, 'prepare should pass');
    const placed = h.dialer.place(prepared.call.requestId, prepared.call.digest);
    assert.ok(placed.ok, 'place should pass');
    return { prepared: prepared.call, handle: placed.handle };
}

describe('phone numbers', () => {
    it('accepts only US numbers and never emergency or service codes', () => {
        assert.equal(toUsE164('(415) 555-0123'), LEON);
        assert.equal(toUsE164('+1 415 555 0123'), LEON);
        for (const bad of ['911', '+1 911 555 0123', '+1 415 911 0123', '+44 20 7946 0000', '415-555', 'call me']) assert.equal(toUsE164(bad), null, bad);
        for (const emergency of ['911', '+1 911', '112', '999', '988', '19115550123']) assert.equal(isEmergencyNumber(emergency), true, emergency);
        assert.equal(isEmergencyNumber(LEON), false);
        assert.equal(spokenNumber(CALLBACK), '415-555-0188');
    });
});

describe('consent and do-not-call lists', () => {
    it('refuses entries without a US number, with an emergency number, or without consent text', () => {
        assert.throws(() => parseConsentList(consentFor({ phone: '911' })), /does not have a US phone number/);
        assert.throws(() => parseConsentList(consentFor({ consentText: 'ok' })), /consent text/);
        assert.throws(() => parseConsentList(consentFor({ consentedAt: '2099-01-01T00:00:00Z' }), MORNING), /past consentedAt/);
        assert.throws(() => parseConsentList('{}'), /JSON array/);
        try {
            parseConsentList(consentFor({ phone: '+1 415 911 0123' }));
        } catch (error) {
            assert.equal(String(error).includes('911 0123'), false);
        }
    });

    it('reads do-not-call numbers and stops on a line it cannot read', () => {
        assert.deepEqual([...parseDoNotCall(`# opted out\n${LEON}\n(415) 555-0177, `)], [LEON, '+14155550177']);
        assert.throws(() => parseDoNotCall('not a number'), /do-not-call/);
    });
});

describe('calling hours', () => {
    it('only calls when the whole call fits inside 9 AM to 9 PM Pacific', () => {
        assert.equal(insideCallingHours(Date.parse('2026-10-24T16:00:00Z'), 0), true);
        assert.equal(insideCallingHours(Date.parse('2026-10-24T15:59:00Z'), 0), false);
        assert.equal(insideCallingHours(Date.parse('2026-10-25T03:55:00Z'), 205_000), true);
        assert.equal(insideCallingHours(Date.parse('2026-10-25T03:57:00Z'), 205_000), false);
    });
});

describe('Dialer guards', () => {
    it('calls only people on the consent list, without touching the network to refuse', () => {
        const h = harness();
        const result = h.dialer.prepare(request(h.clock, { contactId: 'stranger' }));
        assert.deepEqual(result, { ok: false, refusal: { code: 'not_consented', reason: REFUSALS.not_consented } });
        assert.equal(h.fetch.calls.length, 0);
    });

    it('refuses numbers on the do-not-call list and expired consent', () => {
        assert.equal(harness({ dnc: [LEON] }).dialer.prepare(request({ t: MORNING })).ok, false);
        const expired = harness({ consent: consentFor({ expiresAt: '2026-10-24T17:00:00Z' }) });
        const result = expired.dialer.prepare(request(expired.clock));
        assert.ok(!result.ok && result.refusal.code === 'consent_expired');
    });

    it('refuses outside calling hours, counting the whole call', () => {
        const late = harness({ now: Date.parse('2026-10-25T03:57:00Z') });
        const result = late.dialer.prepare(request(late.clock));
        assert.ok(!result.ok && result.refusal.code === 'outside_hours');
        const early = harness({ now: Date.parse('2026-10-24T15:59:00Z') });
        assert.ok(!early.dialer.prepare(request(early.clock)).ok);
    });

    it('only reports a request sent in the last ten minutes', () => {
        const h = harness();
        const result = h.dialer.prepare(request(h.clock, { errand: { title: 'Care team request', sentAt: h.clock.t - 11 * 60_000 } }));
        assert.ok(!result.ok && result.refusal.code === 'errand_stale');
    });

    it('builds a read-back and digest that leave the number inside the dialer', () => {
        const h = harness();
        const prepared = h.dialer.prepare(request(h.clock));
        assert.ok(prepared.ok);
        assert.equal(prepared.call.readBack, 'Call Leon to say your Care team request was sent.');
        assert.match(prepared.call.digest, /^[0-9a-f]{16}$/);
        for (const number of [LEON, '4155550123', '415-555-0123', CALLBACK, '415-555-0188']) {
            assert.equal(JSON.stringify(prepared.call).includes(number), false, number);
        }
        assert.equal(h.fetch.calls.length, 0);
    });

    it('refuses a confirm whose digest does not match the read-back', () => {
        const h = harness();
        const prepared = h.dialer.prepare(request(h.clock));
        assert.ok(prepared.ok);
        const placed = h.dialer.place('call_1', '0000000000000000');
        assert.ok(!placed.ok && placed.refusal.code === 'digest_mismatch');
        assert.equal(h.fetch.calls.length, 0);
    });

    it('refuses a script that skips the disclosure', () => {
        assert.throws(
            () => harness({ config: { script: { welcome: 'Hi {{recipient_name}}, {{message}}.', instructions: script.instructions } } }),
            /agent script is not ready/,
        );
    });
});

describe('Dialer calls', () => {
    it('places one call after a matching confirm, polls every 1.5 s and reports how it ended', async () => {
        const h = harness();
        const { handle } = prepareAndPlace(h);
        const outcome = await handle.done;
        assert.equal(outcome.result, 'answered');
        assert.equal(outcome.dialed, true);
        assert.equal(outcome.callId, 'ac_test');
        assert.equal(outcome.summary, 'Leon got it.');
        assert.equal(outcome.spoken, 'Leon picked up. The call has ended.');
        assert.equal(count(h.fetch.calls, 'POST', '/agents/calls'), 1);
        const dial = h.fetch.calls.find((c) => c.method === 'POST' && new URL(c.url).pathname === '/agents/calls');
        assert.equal(dial?.headers['Cartesia-Version'], '2026-08-14');
        assert.equal(dial?.headers.Authorization, `Bearer ${KEY}`);
        assert.deepEqual(JSON.parse(dial?.body ?? '{}'), {
            agent_id: 'agent_test',
            from_number_id: 'ap_test',
            ringing_timeout_seconds: 25,
            max_call_duration_minutes: 2,
            outbound_calls: [
                {
                    to_number: LEON,
                    dynamic_variables: {
                        recipient_name: 'Leon',
                        person_name: 'Shashank',
                        callback_number: '415-555-0188',
                        message: "Shashank's Care team request was sent at 10:59 AM",
                    },
                },
            ],
        });
        assert.deepEqual(
            h.fetch.calls.slice(0, 3).map((c) => `${c.method} ${new URL(c.url).pathname}`),
            ['GET /v1/agents/agent_test', 'GET /voices', 'POST /agents/calls'],
        );
        assert.deepEqual(h.sleeps, [1500, 1500, 1500]);
        assert.deepEqual(h.updates.map((u) => u.phase).filter((p, i, all) => p !== all[i - 1]), ['dialing', 'ringing', 'connected', 'ended']);
    });

    it('checks the published agent first and refuses a different script', async () => {
        const h = harness({ scenario: { agent: publishedAgent({ initial_message: 'Hi, this is Shashank calling.' }) } });
        const { handle } = prepareAndPlace(h);
        const outcome = await handle.done;
        assert.equal(outcome.result, 'refused');
        assert.equal(outcome.refusal?.code, 'agent_mismatch');
        assert.equal(outcome.spoken, REFUSALS.agent_mismatch);
        assert.equal(count(h.fetch.calls, 'POST', '/agents/calls'), 0);
    });

    it('refuses an agent that speaks with a voice we own, such as a clone', async () => {
        const h = harness({ scenario: { voice: { is_owner: true } } });
        const outcome = await prepareAndPlace(h).handle.done;
        assert.equal(outcome.refusal?.code, 'agent_mismatch');
        assert.equal(count(h.fetch.calls, 'POST', '/agents/calls'), 0);
    });

    it('refuses an agent that would leave an unreviewed voicemail message', async () => {
        const voicemail = { voicemail_detection: { description: null, pre_tool_speech: 'off', message: 'Call me back.' } };
        const h = harness({ scenario: { agent: publishedAgent({ system_tools: voicemail }) } });
        const outcome = await prepareAndPlace(h).handle.done;
        assert.equal(outcome.refusal?.code, 'agent_mismatch');
    });

    it('uses one confirm for one call: the same digest is refused afterwards', async () => {
        const h = harness();
        const first = prepareAndPlace(h);
        await first.handle.done;
        const again = h.dialer.prepare(request(h.clock, { errand: { title: 'Care team request', sentAt: MORNING - 60_000 } }));
        assert.ok(again.ok);
        assert.equal(again.call.digest, first.prepared.digest);
        const placed = h.dialer.place(again.call.requestId, again.call.digest);
        assert.ok(!placed.ok && placed.refusal.code === 'already_used');
        assert.equal(count(h.fetch.calls, 'POST', '/agents/calls'), 1);
    });

    it('allows only one call at a time', async () => {
        const h = harness();
        const first = prepareAndPlace(h);
        const second = h.dialer.prepare(request(h.clock, { requestId: 'call_2', errand: { title: 'Lunch order', sentAt: h.clock.t - 1000 } }));
        assert.ok(second.ok);
        const placed = h.dialer.place('call_2', second.call.digest);
        assert.ok(!placed.ok && placed.refusal.code === 'line_busy');
        await first.handle.done;
    });

    it('never retries a dial that got no answer', async () => {
        const h = harness({
            scenario: {
                dial: () => {
                    throw new Error('socket hang up');
                },
            },
        });
        const outcome = await prepareAndPlace(h).handle.done;
        assert.equal(outcome.result, 'unknown');
        assert.equal(outcome.dialed, 'unknown');
        assert.equal(outcome.spoken, 'I could not tell if the call went out. Check before trying again.');
        assert.equal(count(h.fetch.calls, 'POST', '/agents/calls'), 1);
    });

    it('reports a per-destination dial error as failed, without polling', async () => {
        const h = harness({ scenario: { dial: () => ({ status: 200, body: { calls: [{ number: LEON, error: { message: 'Invalid number' } }] } }) } });
        const outcome = await prepareAndPlace(h).handle.done;
        assert.equal(outcome.result, 'failed');
        assert.equal(outcome.dialed, false);
        assert.equal(count(h.fetch.calls, 'GET', '/agents/calls/ac_test'), 0);
    });

    it('cancel-pending: a NO while ringing cancels the moment the call starts', async () => {
        let dialer: Dialer | undefined;
        const h = harness({
            scenario: {
                statuses: [{ status: 'created' }, { status: 'started' }, { status: 'started' }],
                dial: () => {
                    dialer?.cancelActive('no');
                    return { status: 200, body: { calls: [{ number: LEON, agent_call_id: 'ac_test' }] } };
                },
            },
        });
        dialer = h.dialer;
        const outcome = await prepareAndPlace(h).handle.done;
        assert.equal(outcome.result, 'cancelled');
        assert.equal(outcome.cancelReason, 'no');
        assert.equal(outcome.dialed, true);
        assert.equal(outcome.spoken, 'The call was cancelled.');
        const order = h.fetch.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`);
        const cancelAt = order.indexOf('POST /agents/calls/ac_test/cancel');
        assert.equal(order.filter((line) => line === 'POST /agents/calls/ac_test/cancel').length, 1);
        assert.equal(order.slice(0, cancelAt).filter((line) => line === 'GET /agents/calls/ac_test').length, 2);
        assert.ok(h.events.some((event) => event.detail === 'cancel pending'));
    });

    it('a cancel before dialing places no call', async () => {
        const h = harness();
        const { handle } = prepareAndPlace(h);
        handle.cancel('headset_off');
        const outcome = await handle.done;
        assert.equal(outcome.result, 'cancelled');
        assert.equal(outcome.dialed, false);
        assert.equal(outcome.spoken, 'Cancelled. No call was made.');
        assert.equal(count(h.fetch.calls, 'POST', '/agents/calls'), 0);
    });

    it('gives up at the deadline, sends one last cancel and never dials again', async () => {
        const h = harness({ scenario: { statuses: [], cancelStatus: 400 } });
        const outcome = await prepareAndPlace(h).handle.done;
        assert.equal(outcome.result, 'unknown');
        assert.equal(outcome.dialed, true);
        assert.equal(count(h.fetch.calls, 'POST', '/agents/calls'), 1);
        assert.equal(count(h.fetch.calls, 'POST', '/cancel'), 1);
        assert.ok(h.sleeps.length > 100);
    });

    it('adds an opt-out heard on the call to the do-not-call list', async () => {
        const transcript = [
            { role: 'assistant', text: 'Did you get it?', start_timestamp: 1, end_timestamp: 2 },
            { role: 'user', text: 'Yes. Please don\u2019t call me again.', start_timestamp: 3, end_timestamp: 4 },
        ];
        const h = harness({ scenario: { statuses: [{ status: 'started' }, { status: 'completed', end_reason: 'agent_hangup', transcript }] } });
        const outcome = await prepareAndPlace(h).handle.done;
        assert.equal(outcome.optedOut, true);
        assert.equal(outcome.spoken, 'Leon asked not to be called again. I will not call them.');
        assert.deepEqual(h.optOuts, [LEON]);
        const next = h.dialer.prepare(request(h.clock, { requestId: 'call_2', errand: { title: 'Lunch order', sentAt: h.clock.t } }));
        assert.ok(!next.ok && next.refusal.code === 'do_not_call');
    });

    it('checks the setup without placing a call', async () => {
        const h = harness();
        const report = await h.dialer.preflight();
        assert.deepEqual(report, { ok: true, consentCount: 1, doNotCallCount: 0, scriptProblems: [], agent: { ok: true }, insideHoursNow: true });
        assert.equal(count(h.fetch.calls, 'POST', '/agents/calls'), 0);
    });

    it('keeps the API key and every phone number out of events and logs', async () => {
        const logged: string[] = [];
        const original = { log: console.log, info: console.info, warn: console.warn, error: console.error };
        for (const name of ['log', 'info', 'warn', 'error'] as const) console[name] = (...args: unknown[]) => void logged.push(args.map(String).join(' '));
        try {
            const h = harness();
            await prepareAndPlace(h).handle.done;
            harness({ dnc: [LEON] }).dialer.prepare(request({ t: MORNING }));
            const visible = JSON.stringify([h.events, logged]);
            for (const secret of [KEY, '4155550123', '415-555-0123', '4155550188', '415-555-0188', '+1415']) {
                assert.equal(visible.includes(secret), false, secret);
            }
            assert.ok(h.events.length > 3);
            assert.deepEqual(logged, []);
        } finally {
            Object.assign(console, original);
        }
    });
});

describe('call data', () => {
    it('deletes call data, retrying a 500 as the reference says', async () => {
        let attempts = 0;
        const fetch = fakeFetch(() => (++attempts === 1 ? { status: 500, body: { title: 'Retry', message: 'later', request_id: 'r' } } : { status: 200, body: { id: 'ac_1' } }));
        const result = await deleteCallData({ apiKey: KEY, callId: 'ac_1', fetch, sleep: async () => undefined });
        assert.deepEqual(result, { callId: 'ac_1', deleted: true, reason: 'deleted' });
        assert.equal(fetch.calls.length, 2);
        assert.equal(fetch.calls[0]?.method, 'DELETE');
        assert.equal(fetch.calls[0]?.url, 'https://api.cartesia.ai/agents/calls/ac_1');
        const notOver = await deleteCallData({ apiKey: KEY, callId: 'ac_2', fetch: fakeFetch(() => ({ status: 400 })) });
        assert.equal(notOver.reason, 'not_terminal');
        const gone = await deleteCallData({ apiKey: KEY, callId: 'ac_3', fetch: fakeFetch(() => ({ status: 404 })) });
        assert.equal(gone.reason, 'not_found');
    });
});

describe('the reviewed script', () => {
    it('discloses the AI voice, the recording and the callback number before the message', () => {
        assert.deepEqual(checkAgentScript(script), []);
        const spoken = renderTemplate(script.welcome, {
            recipient_name: 'Leon',
            person_name: 'Shashank',
            callback_number: '415-555-0188',
            message: "Shashank's Care team request was sent at 10:59 AM",
        });
        const at = (phrase: string) => spoken.indexOf(phrase);
        assert.ok(at('automated assistant') >= 0 && at('AI-generated voice') >= 0 && at('recorded') >= 0);
        assert.ok(at('415-555-0188') < at('Care team request'));
        assert.match(script.instructions, /You are not \{\{person_name\}\}/);
        assert.match(script.instructions, /call \{\{callback_number\}\}\. Goodbye\./);
    });
});
