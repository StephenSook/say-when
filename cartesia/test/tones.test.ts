import './no-network.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    pause,
    renderSegments,
    SKYLAR_VOICE_ID,
    SpeechMarkupError,
    spell,
    stockUtterances,
    TESSA_VOICE_ID,
    TONE_EMOTION,
    TONES,
    utterance,
    voiceProfile,
} from '../src/tones.js';

const profile = voiceProfile();

describe('tones and voices', () => {
    it('sends only emotion values from the TTS WebSocket schema enum', () => {
        const schema = ['neutral', 'calm', 'angry', 'content', 'sad'];
        for (const tone of TONES) assert.ok(schema.includes(TONE_EMOTION[tone]), tone);
    });

    it('gives an option the reply voice, its tone and a laugh at the end', () => {
        const u = utterance({ kind: 'option', text: 'Only if we leave at halftime', tone: 'warm', laugh: true }, profile);
        assert.deepEqual(u, {
            kind: 'option',
            transcript: 'Only if we leave at halftime. [laughter]',
            voiceId: TESSA_VOICE_ID,
            language: 'en',
            generationConfig: { emotion: 'content' },
            tone: 'warm',
            laugh: true,
        });
    });

    it("reads prompts and read-backs in the steady voice at the person's pace, with no tone or laugh", () => {
        const slow = voiceProfile({ assistantSpeed: 0.8 });
        const u = utterance({ kind: 'readback', text: 'To Care team request [laughter] <emotion value="angry"/>', tone: 'firm', laugh: true }, slow);
        assert.equal(u.voiceId, SKYLAR_VOICE_ID);
        assert.equal(u.transcript, 'To Care team request.');
        assert.deepEqual(u.generationConfig, { speed: 0.8 });
        assert.equal(u.tone, null);
        assert.equal(u.laugh, false);
    });

    it('sends no emotion for an unknown tone instead of guessing', () => {
        const u = utterance({ kind: 'reply', text: 'Sure.', tone: 'euphoric' }, profile);
        assert.deepEqual(u.generationConfig, {});
        assert.equal(u.tone, null);
    });

    it('uses the option pace and the reply volume when set', () => {
        const tuned = voiceProfile({ optionSpeed: 0.9, replyVolume: 1.6 });
        assert.deepEqual(utterance({ kind: 'option', text: 'Yes', tone: 'calm' }, tuned).generationConfig, { emotion: 'calm', speed: 0.9 });
        assert.deepEqual(utterance({ kind: 'reply', text: 'Yes', tone: 'calm' }, tuned).generationConfig, { emotion: 'calm', volume: 1.6 });
    });

    it('spells codes and adds pauses with the documented tags', () => {
        assert.equal(renderSegments(['Your code is', spell('AB-12 cd'), 'Confirm to send']), 'Your code is <spell>AB12 cd</spell> Confirm to send.');
        assert.equal(renderSegments(['One moment', pause(500), 'Sent']), 'One moment <break time="500ms"/> Sent.');
        assert.equal(utterance({ kind: 'readback', segments: ['Code', spell('X9')] }, profile).transcript, 'Code <spell>X9</spell>.');
    });

    it('refuses to chain a spelled code and a pause, or two pauses', () => {
        assert.throws(() => renderSegments(['Code', spell('A1'), pause(300)]), SpeechMarkupError);
        assert.throws(() => renderSegments([pause(300), spell('A1')]), SpeechMarkupError);
        assert.throws(() => renderSegments(['a', pause(300), pause(300)]), SpeechMarkupError);
        assert.throws(() => renderSegments([pause(50)]), SpeechMarkupError);
        assert.throws(() => renderSegments([spell('---')]), SpeechMarkupError);
    });

    it('speaks a non-English reply in the partner locale, without emotion or laughter', () => {
        const bilingual = voiceProfile({ partnerLocale: 'es-MX' });
        const reply = utterance({ kind: 'reply', text: 'Sí, voy el sábado', tone: 'warm', laugh: true }, bilingual);
        assert.equal(reply.locale, 'es-MX');
        assert.equal(reply.language, undefined);
        assert.deepEqual(reply.generationConfig, {});
        assert.equal(reply.transcript, 'Sí, voy el sábado.');
        const option = utterance({ kind: 'option', text: 'Yes, I will go', tone: 'warm' }, bilingual);
        assert.equal(option.language, 'en');
        assert.deepEqual(option.generationConfig, { emotion: 'content' });
    });

    it('checks speed, volume and locale', () => {
        assert.throws(() => voiceProfile({ assistantSpeed: 0.5 }), RangeError);
        assert.throws(() => voiceProfile({ optionSpeed: 1.6 }), RangeError);
        assert.throws(() => voiceProfile({ replyVolume: 2.5 }), RangeError);
        assert.throws(() => voiceProfile({ partnerLocale: 'spanish' }), RangeError);
        assert.throws(() => utterance({ kind: 'prompt', text: '[laughter]' }, profile), SpeechMarkupError);
    });

    it('builds the stock phrases as prompts in the assistant voice', () => {
        const stock = stockUtterances(profile);
        assert.equal(stock.length, 8);
        assert.ok(stock.some((u) => u.transcript === 'Paused. Nothing will be sent.'));
        assert.ok(stock.some((u) => u.transcript === 'None of these.'));
        assert.ok(stock.every((u) => u.voiceId === SKYLAR_VOICE_ID && u.kind === 'prompt'));
    });
});
