import './no-network.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { PipelineEvent } from '../src/events.js';
import { checkTurnSettings, listen, sttUrl, TURN_PROFILES, type ListenOptions } from '../src/stt.js';
import { deferred, FakeAudio, FakeSocket, flush, ManualTimers, settled } from './fakes.js';

function setup(extra: Partial<ListenOptions> = {}) {
    FakeSocket.reset();
    const timers = new ManualTimers();
    const audio = new FakeAudio();
    const events: PipelineEvent[] = [];
    const seen: string[] = [];
    const session = listen({
        getToken: async () => 'tok_listen',
        socket: (url) => new FakeSocket(url),
        timers,
        now: () => timers.now,
        audio,
        onEvent: (event) => events.push(event),
        onPartial: (text) => seen.push(`partial:${text}`),
        onEagerEnd: (text) => seen.push(`eager:${text}`),
        onResume: () => seen.push('resume'),
        onTurn: (text) => seen.push(`turn:${text}`),
        ...extra,
    });
    return { session, timers, audio, events, seen };
}

async function opened(): Promise<FakeSocket> {
    await flush();
    const socket = FakeSocket.last();
    socket.open();
    await flush();
    return socket;
}

const turn = (type: string, transcript?: string) => ({ type, request_id: 'req_1', ...(transcript === undefined ? {} : { transcript }) });

describe('sttUrl', () => {
    it('opens the Ink-2 turns socket with keyterms, turn settings, the version and the token', () => {
        const raw = sttUrl('tok', { keyterms: ['Ink 2', 'Siobhan'], turn: TURN_PROFILES.patient });
        assert.ok(raw.includes('keyterm=Ink%202&keyterm=Siobhan'));
        const url = new URL(raw);
        assert.equal(`${url.protocol}//${url.host}${url.pathname}`, 'wss://api.cartesia.ai/stt/turns/websocket');
        assert.equal(url.searchParams.get('model'), 'ink-2');
        assert.equal(url.searchParams.get('encoding'), 'pcm_s16le');
        assert.equal(url.searchParams.get('sample_rate'), '16000');
        assert.equal(url.searchParams.get('cartesia_version'), '2026-08-14');
        assert.equal(url.searchParams.get('access_token'), 'tok');
        assert.deepEqual(url.searchParams.getAll('keyterm'), ['Ink 2', 'Siobhan']);
        assert.equal(url.searchParams.get('turn_start_threshold'), '0.8');
        assert.equal(url.searchParams.get('turn_eager_end_threshold'), '0.3');
        assert.equal(url.searchParams.get('turn_end_threshold'), '0.1');
        assert.equal(url.searchParams.get('turn_end_timeout_ms'), '8000');
        assert.equal(new URL(sttUrl('tok')).searchParams.has('turn_end_threshold'), false);
    });

    it('checks the documented turn ranges and their order', () => {
        for (const profile of Object.values(TURN_PROFILES)) assert.equal(checkTurnSettings(profile), null);
        assert.match(String(checkTurnSettings({ startThreshold: 0.8, eagerEndThreshold: 0.8, endThreshold: 0.3, endTimeoutMs: 5600 })), /high to low/);
        assert.match(String(checkTurnSettings({ startThreshold: 0.8, eagerEndThreshold: 0.6, endThreshold: 0.3, endTimeoutMs: 500 })), /640/);
        assert.throws(() => sttUrl('tok', { turn: { startThreshold: 1, eagerEndThreshold: 0.6, endThreshold: 0.3, endTimeoutMs: 5600 } }), RangeError);
    });
});

describe('listen', () => {
    it('streams while held, reports partials and eager ends, and finishes on the turn end', async () => {
        const { session, audio, seen } = setup();
        assert.equal(audio.started, true);
        audio.feed();
        audio.feed();
        const socket = await opened();
        assert.equal(socket.binaries().length, 2);
        audio.feed();
        assert.equal(socket.binaries().length, 3);
        socket.receive(turn('connected'));
        socket.receive(turn('turn.start'));
        socket.receive(turn('turn.update', 'Are you'));
        socket.receive(turn('turn.eager_end', 'Are you coming'));
        socket.receive(turn('turn.resume'));
        socket.receive(turn('turn.update', 'Are you coming Saturday'));
        socket.receive(turn('turn.end', 'Are you coming Saturday?'));
        const result = await session.done;
        assert.deepEqual(result, { ok: true, text: 'Are you coming Saturday?', turns: 1, complete: true, reason: 'turn_end', ms: 0 });
        assert.equal(audio.stopped, true);
        assert.deepEqual(JSON.parse(String(socket.sent.at(-1))), { type: 'close' });
        assert.deepEqual([...(socket.sent.at(-2) as Uint8Array)], [7, 7]);
        assert.deepEqual(seen, ['partial:Are you', 'eager:Are you coming', 'resume', 'partial:Are you coming Saturday', 'turn:Are you coming Saturday?']);
        const sentBefore = socket.sent.length;
        audio.feed();
        assert.equal(socket.sent.length, sentBefore);
    });

    it('in release mode collects every turn until the button is let go', async () => {
        const { session, audio } = setup({ endOn: 'release' });
        const socket = await opened();
        socket.receive(turn('turn.end', 'Is the cafe open'));
        socket.receive(turn('turn.end', 'on Sunday?'));
        assert.equal(audio.stopped, false);
        session.release();
        assert.equal(audio.stopped, true);
        assert.deepEqual(JSON.parse(String(socket.sent.at(-1))), { type: 'close' });
        socket.serverClose();
        const result = await session.done;
        assert.ok(result.ok);
        if (result.ok) {
            assert.equal(result.text, 'Is the cafe open on Sunday?');
            assert.equal(result.turns, 2);
            assert.equal(result.reason, 'release');
        }
    });

    it('takes the final turn the server sends after the button is let go', async () => {
        const { session } = setup();
        const socket = await opened();
        socket.receive(turn('turn.update', 'Where is'));
        session.release();
        socket.receive(turn('turn.end', 'Where is the clinic?'));
        const result = await session.done;
        assert.ok(result.ok && result.text === 'Where is the clinic?' && result.complete && result.reason === 'release');
    });

    it('keeps an unfinished turn when the server closes without a turn end', async () => {
        const { session } = setup();
        const socket = await opened();
        socket.receive(turn('turn.update', 'Is the pharmacy'));
        session.release();
        socket.serverClose();
        const result = await session.done;
        assert.ok(result.ok);
        if (result.ok) {
            assert.equal(result.text, 'Is the pharmacy');
            assert.equal(result.complete, false);
        }
    });

    it('stops a stuck button at the time limit', async () => {
        const { session, timers, audio } = setup({ maxMs: 5000 });
        const socket = await opened();
        socket.receive(turn('turn.update', 'hello'));
        timers.tick(5000);
        assert.equal(audio.stopped, true);
        assert.deepEqual(JSON.parse(String(socket.sent.at(-1))), { type: 'close' });
        timers.tick(3000);
        const result = await session.done;
        assert.ok(result.ok && result.reason === 'timeout' && !result.complete);
    });

    it('sends audio held before the socket opened, then the close command', async () => {
        const { session, audio } = setup();
        audio.feed();
        session.release();
        const socket = await opened();
        assert.equal(socket.binaries().length, 2);
        assert.deepEqual(JSON.parse(String(socket.sent.at(-1))), { type: 'close' });
        socket.receive(turn('turn.end', 'Hi'));
        const result = await session.done;
        assert.ok(result.ok && result.text === 'Hi');
    });

    it('reports an error event without leaking the token', async () => {
        const { session, audio } = setup();
        const socket = await opened();
        socket.receive({ type: 'error', title: 'Unauthorized', message: 'access_token=tok_listen expired', status_code: 401, request_id: 'r' });
        const result = await session.done;
        assert.equal(result.ok, false);
        if (!result.ok) {
            assert.equal(result.reason, 'error');
            assert.equal(result.message.includes('tok_listen'), false);
        }
        assert.equal(audio.stopped, true);
        assert.equal(socket.readyState, 3);
    });

    it('says when no speech was heard', async () => {
        const { session } = setup();
        const socket = await opened();
        session.release();
        socket.serverClose();
        const result = await session.done;
        assert.ok(!result.ok && result.reason === 'no_speech');
    });

    it('refuses an API key as the token and opens nothing', async () => {
        const { session, audio } = setup({ getToken: async () => 'sk_car_nope' });
        const result = await session.done;
        assert.ok(!result.ok && result.reason === 'error' && /API key/.test(result.message));
        assert.equal(FakeSocket.created.length, 0);
        assert.equal(audio.stopped, true);
    });

    it('aborts by stopping the mic and closing the socket', async () => {
        const { session, audio } = setup();
        const socket = await opened();
        session.abort();
        const result = await session.done;
        assert.ok(!result.ok && result.reason === 'aborted');
        assert.equal(audio.stopped, true);
        assert.equal(socket.closedWith?.code, 1000);
    });

    it('reports a connection that never opens as an error', async () => {
        const { session } = setup();
        await flush();
        FakeSocket.last().serverClose(1006);
        const result = await session.done;
        assert.ok(!result.ok && result.reason === 'error');
    });

    it('ends a release on time even when the token never arrives, and opens nothing later', async () => {
        const token = deferred<string>();
        const { session, timers, audio } = setup({ getToken: () => token.promise });
        audio.feed();
        session.release();
        assert.equal(audio.stopped, true);
        timers.tick(5000);
        const result = await settled(session.done);
        assert.ok(result !== 'pending' && 'value' in result && !result.value.ok && result.value.reason === 'error', JSON.stringify(result));
        token.resolve('tok_late');
        await flush();
        assert.equal(FakeSocket.created.length, 0);
    });

    it('gives up on a token that never arrives while the button is held', async () => {
        const { session, timers, audio } = setup({ getToken: () => new Promise<string>(() => undefined) });
        timers.tick(10_000);
        const result = await settled(session.done);
        assert.ok(result !== 'pending' && 'value' in result && !result.value.ok && /token/.test(result.value.message), JSON.stringify(result));
        assert.equal(audio.stopped, true);
    });
});
