import './no-network.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { PipelineEvent } from '../src/events.js';
import { stockUtterance, TESSA_VOICE_ID, utterance, voiceProfile } from '../src/tones.js';
import { AudioOut, PhraseCache, TtsCancelled, TtsError, TtsPlayer, wordAt, type TtsPlayerOptions } from '../src/tts.js';
import { deferred, FakeAudioContext, fakeClip, FakeSocket, flush, ManualTimers, settled } from './fakes.js';

const profile = voiceProfile();
const option = utterance({ kind: 'option', text: 'Absolutely, count me in!', tone: 'warm' }, profile);
const audio = (samples: number) => Buffer.from(new Uint8Array(samples * 2).fill(1)).toString('base64');
const done = (contextId: string) => ({ type: 'done', done: true, status_code: 206, context_id: contextId });

function setup(extra: Partial<TtsPlayerOptions> = {}) {
    FakeSocket.reset();
    const timers = new ManualTimers();
    const events: PipelineEvent[] = [];
    const player = new TtsPlayer({
        getToken: async () => 'tok_test',
        socket: (url) => new FakeSocket(url),
        timers,
        now: () => timers.now,
        pronunciationDictId: 'pdict_household',
        onEvent: (event) => events.push(event),
        ...extra,
    });
    return { player, timers, events };
}

async function opened(): Promise<FakeSocket> {
    await flush();
    const socket = FakeSocket.last();
    socket.open();
    await flush();
    return socket;
}

describe('TtsPlayer', () => {
    it('connects with the access token and version in the query, never an API key', async () => {
        const { player } = setup();
        const job = player.speak(option);
        const socket = await opened();
        const url = new URL(socket.url);
        assert.equal(`${url.protocol}//${url.host}${url.pathname}`, 'wss://api.cartesia.ai/tts/websocket');
        assert.equal(url.searchParams.get('cartesia_version'), '2026-08-14');
        assert.equal(url.searchParams.get('access_token'), 'tok_test');
        assert.equal(url.searchParams.has('api_key'), false);
        socket.receive(done(job.contextId));
        await job.done;
    });

    it('sends one request with the tone, the dictionary, word timestamps and no buffering', async () => {
        const { player } = setup();
        const job = player.speak(utterance({ kind: 'option', text: 'Only if we leave at halftime', tone: 'warm', laugh: true }, profile));
        const socket = await opened();
        assert.deepEqual(socket.texts(), [
            {
                model_id: 'sonic-3.6',
                transcript: 'Only if we leave at halftime. [laughter]',
                voice: TESSA_VOICE_ID,
                output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: 24000 },
                context_id: job.contextId,
                continue: false,
                max_buffer_delay_ms: 0,
                add_timestamps: true,
                use_normalized_timestamps: false,
                language: 'en',
                pronunciation_dict_id: 'pdict_household',
                generation_config: { emotion: 'content' },
            },
        ]);
        socket.receive(done(job.contextId));
        await job.done;
    });

    it('measures the clip from its audio bytes and keeps word timings in ms', async () => {
        const { player, events } = setup();
        const job = player.speak(option);
        const socket = await opened();
        const id = job.contextId;
        socket.receive({ type: 'chunk', data: audio(12_000), done: false, status_code: 206, step_time: 9, context_id: id });
        socket.receive({ type: 'timestamps', done: false, status_code: 206, context_id: id, word_timestamps: { words: ['Absolutely,'], start: [0], end: [0.42] } });
        socket.receive({ type: 'chunk', data: audio(12_000), done: false, status_code: 206, step_time: 9, context_id: id });
        socket.receive({
            type: 'timestamps',
            done: false,
            status_code: 206,
            context_id: id,
            word_timestamps: { words: ['count', 'me', 'in!'], start: [0.5, 0.71, 0.8], end: [0.7, 0.79, 0.95] },
        });
        socket.receive(done(id));
        const clip = await job.done;
        assert.equal(clip.pcm.byteLength, 48_000);
        assert.equal(clip.durationMs, 1000);
        assert.deepEqual(clip.words, [
            { word: 'Absolutely,', startMs: 0, endMs: 420 },
            { word: 'count', startMs: 500, endMs: 700 },
            { word: 'me', startMs: 710, endMs: 790 },
            { word: 'in!', startMs: 800, endMs: 950 },
        ]);
        assert.equal(wordAt(clip.words, 600), 1);
        assert.equal(wordAt(clip.words, 850), 3);
        assert.equal(wordAt([], 10), -1);
        const ready = events.find((event) => event.detail === 'clip ready option');
        assert.deepEqual(ready?.counts, { clipMs: 1000, words: 4, firstAudioMs: 0 });
    });

    it('generates one option at a time', async () => {
        const { player } = setup();
        const first = player.speak(option);
        const second = player.speak(utterance({ kind: 'option', text: "Not this week, I'm worn out.", tone: 'sad' }, profile));
        const socket = await opened();
        assert.equal(socket.texts().length, 1);
        socket.receive(done(first.contextId));
        await first.done;
        await flush();
        const texts = socket.texts();
        assert.equal(texts.length, 2);
        assert.equal(texts[1]?.context_id, second.contextId);
        assert.deepEqual(texts[1]?.generation_config, { emotion: 'sad' });
        socket.receive(done(second.contextId));
        await second.done;
        assert.equal(FakeSocket.created.length, 1);
    });

    it('cancels a generating context, ignores its late audio and moves on', async () => {
        const { player } = setup();
        const job = player.speak(option);
        const socket = await opened();
        job.cancel();
        await assert.rejects(job.done, TtsCancelled);
        assert.deepEqual(socket.texts()[1], { context_id: job.contextId, cancel: true });
        socket.receive({ type: 'chunk', data: audio(100), done: false, status_code: 206, step_time: 1, context_id: job.contextId });
        const next = player.speak(option);
        await flush();
        socket.receive(done(next.contextId));
        const clip = await next.done;
        assert.equal(clip.pcm.byteLength, 0);
    });

    it('drops a queued job that is cancelled before it is sent', async () => {
        const { player } = setup();
        const first = player.speak(option);
        const queued = player.speak(option);
        const socket = await opened();
        queued.cancel();
        await assert.rejects(queued.done, TtsCancelled);
        socket.receive(done(first.contextId));
        await first.done;
        await flush();
        assert.equal(socket.texts().length, 1);
    });

    it('reports a context error without leaking a key', async () => {
        const { player } = setup();
        const job = player.speak(option);
        const socket = await opened();
        socket.receive({
            type: 'error',
            done: true,
            status_code: 400,
            error_code: 'voice_not_found',
            title: 'Voice not found',
            message: 'sk_car_leaked_9 asked for it',
            context_id: job.contextId,
        });
        await assert.rejects(
            job.done,
            (error: unknown) => error instanceof TtsError && error.errorCode === 'voice_not_found' && !error.message.includes('sk_car_leaked_9'),
        );
    });

    it('refuses an API key in place of an access token', async () => {
        const { player } = setup({ getToken: async () => 'sk_car_should_never_be_here' });
        const job = player.speak(option);
        await assert.rejects(job.done, /API key/);
        assert.equal(FakeSocket.created.length, 0);
    });

    it('times out a silent generation and cancels it', async () => {
        const { player, timers } = setup();
        const job = player.speak(option);
        const socket = await opened();
        timers.tick(10_000);
        await assert.rejects(job.done, (error: unknown) => error instanceof TtsError && error.errorCode === 'timeout');
        assert.deepEqual(socket.texts().at(-1), { context_id: job.contextId, cancel: true });
    });

    it('fails pending work when the socket closes and reconnects with a fresh token', async () => {
        let minted = 0;
        const { player } = setup({ getToken: async () => `tok_${++minted}` });
        const job = player.speak(option);
        const socket = await opened();
        socket.serverClose(1006);
        await assert.rejects(job.done, TtsError);
        const next = player.speak(option);
        const second = await opened();
        assert.equal(FakeSocket.created.length, 2);
        assert.equal(new URL(second.url).searchParams.get('access_token'), 'tok_2');
        second.receive(done(next.contextId));
        await next.done;
    });

    it('streams text into one context with continuations and managed buffering', async () => {
        const { player } = setup();
        const stream = player.stream(utterance({ kind: 'reply', text: 'unused', tone: 'calm' }, profile), { mode: 'tokens' });
        void stream.push('Sure, ');
        void stream.push('see you [there].');
        const ended = stream.end();
        const socket = await opened();
        await ended;
        const texts = socket.texts();
        assert.deepEqual(
            texts.map((text) => [text.transcript, text.continue, text.max_buffer_delay_ms, text.context_id]),
            [
                ['Sure, ', true, 1000, stream.contextId],
                ['see you there.', true, 1000, stream.contextId],
                ['', false, 1000, stream.contextId],
            ],
        );
        assert.ok(texts.every((text) => JSON.stringify(text.generation_config) === '{"emotion":"calm"}'));
        await assert.rejects(stream.push('more'), /already ended/);
        socket.receive({ type: 'chunk', data: audio(2400), done: false, status_code: 206, step_time: 1, context_id: stream.contextId });
        socket.receive(done(stream.contextId));
        assert.equal((await stream.done).durationMs, 100);
    });

    it('drops an error code that could carry a key', async () => {
        const { player } = setup();
        const job = player.speak(option);
        const socket = await opened();
        socket.receive({ type: 'error', done: true, status_code: 400, error_code: 'sk_car_echoed', title: 'Bad', message: 'x', context_id: job.contextId });
        const result = await settled(job.done);
        assert.ok(result !== 'pending' && 'error' in result && result.error instanceof TtsError);
        assert.equal(JSON.stringify(result.error).includes('sk_car_echoed'), false);
    });
});

describe('TtsPlayer cancellation during setup', () => {
    it('cancelAll while the token is on its way ends the job at once and opens nothing later', async () => {
        const token = deferred<string>();
        const { player } = setup({ getToken: () => token.promise });
        const job = player.speak(option);
        await flush();
        player.cancelAll();
        const result = await settled(job.done);
        assert.ok(result !== 'pending' && 'error' in result && result.error instanceof TtsCancelled, String(result));
        token.resolve('tok_late');
        await flush();
        assert.equal(FakeSocket.created.length, 0);
    });

    it('close while the socket is opening closes it and sends nothing', async () => {
        const { player } = setup();
        const job = player.speak(option);
        await flush();
        const socket = FakeSocket.last();
        player.close();
        const result = await settled(job.done);
        assert.ok(result !== 'pending' && 'error' in result && result.error instanceof TtsCancelled);
        assert.equal(socket.closedWith?.code, 1000);
        assert.equal(socket.sent.length, 0);
        assert.equal(player.speak(option).contextId.startsWith('tts-'), true);
    });

    it('a job started after cancelAll gets a fresh connection, not the cancelled one', async () => {
        const first = deferred<string>();
        let asked = 0;
        const { player } = setup({ getToken: () => (++asked === 1 ? first.promise : Promise.resolve('tok_fresh')) });
        const cancelled = player.speak(option);
        await flush();
        player.cancelAll();
        const next = player.speak(option);
        const socket = await opened();
        assert.equal(new URL(socket.url).searchParams.get('access_token'), 'tok_fresh');
        socket.receive(done(next.contextId));
        const nextResult = await settled(next.done);
        assert.ok(nextResult !== 'pending' && 'value' in nextResult);
        const cancelledResult = await settled(cancelled.done);
        assert.ok(cancelledResult !== 'pending' && 'error' in cancelledResult && cancelledResult.error instanceof TtsCancelled);
        first.resolve('tok_late');
        await flush();
        assert.equal(FakeSocket.created.length, 1);
    });

    it('gives up on a token that never arrives', async () => {
        const { player, timers } = setup({ getToken: () => new Promise<string>(() => undefined) });
        const job = player.speak(option);
        await flush();
        timers.tick(10_000);
        const result = await settled(job.done);
        assert.ok(result !== 'pending' && 'error' in result && /token/.test(String(result.error)));
    });
});

describe('PhraseCache', () => {
    it('generates a stock phrase once and reuses it', async () => {
        const { player } = setup();
        const cache = new PhraseCache(player);
        const paused = stockUtterance('paused', profile);
        const a = cache.get(paused);
        const b = cache.get(paused);
        const socket = await opened();
        assert.equal(socket.texts().length, 1);
        assert.equal(socket.texts()[0]?.transcript, 'Paused. Nothing will be sent.');
        const id = String(socket.texts()[0]?.context_id);
        socket.receive({ type: 'chunk', data: audio(2400), done: false, status_code: 206, step_time: 1, context_id: id });
        socket.receive(done(id));
        const [clipA, clipB] = await Promise.all([a, b]);
        assert.equal(clipA, clipB);
        assert.equal(cache.peek(paused), clipA);
        await cache.get(paused);
        assert.equal(socket.texts().length, 1);
        assert.notEqual(cache.key(paused), cache.key(stockUtterance('sent', profile)));
    });
});

describe('AudioOut', () => {
    it('schedules streamed chunks back to back and reports the position', () => {
        const context = new FakeAudioContext();
        context.currentTime = 10;
        const out = new AudioOut(context);
        out.enqueue(new Uint8Array(4800));
        out.enqueue(new Uint8Array(4801));
        out.enqueue(new Uint8Array(1));
        assert.deepEqual(
            context.started.map((s) => [Math.round(s.at * 1000) / 1000, s.length]),
            [
                [10.05, 2400],
                [10.15, 2400],
                [10.25, 1],
            ],
        );
        context.currentTime = 10.15;
        assert.equal(Math.round(out.positionMs()), 100);
        assert.equal(out.playing, true);
        out.stop();
        assert.ok(context.sources.every((source) => source.stopped));
    });

    it('plays a clip to the end, or reports that it was stopped', async () => {
        const context = new FakeAudioContext();
        const out = new AudioOut(context);
        const first = out.play(fakeClip(2400));
        context.sources.at(-1)?.end();
        assert.equal(await first, 'ended');
        const second = out.play(fakeClip(2400));
        out.stop();
        assert.equal(await second, 'stopped');
    });
});
