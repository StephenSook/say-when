import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { classifyQuestion, type QuestionKind } from '../src/classify.js';

type Case = [question: string, kind: QuestionKind, needsWeb: boolean];

const CASES: Case[] = [
    // Places: live place data helps.
    ['Want to grab lunch after this?', 'places', true],
    ['Is there a pharmacy near here?', 'places', true],
    ['Where can we get coffee around here?', 'places', true],
    ['Is the cafe on Bancroft still open?', 'places', true],
    ['What time does the pharmacy close?', 'places', true],
    ['How do we get to the station from here?', 'places', true],
    ['Any good restaurants nearby?', 'places', true],
    ['Where do you want to eat tonight?', 'places', true],
    ['Is Chez Panisse open on Sunday?', 'places', true],
    ['How far is the park?', 'places', true],
    ['Do you want to go to Target?', 'places', true],
    ['is it open right now', 'places', true],
    ['Do you know where the nearest restroom is?', 'places', true],

    // Facts: outside facts help.
    ["What's the weather like tomorrow?", 'facts', true],
    ['Is it going to rain later?', 'facts', true],
    ['Who won the game last night?', 'facts', true],
    ["What's the score?", 'facts', true],
    ['How much does a ticket cost?', 'facts', true],
    ['When does the movie start?', 'facts', true],
    ['Did you hear the news about the election?', 'facts', true],
    ['What are their hours on Sunday?', 'facts', true],
    ['Who is the president of France?', 'facts', true],
    ['Did the Warriors win?', 'facts', true],
    ["What do you think about Taylor Swift's new album?", 'facts', true],
    ['How much is a coffee here?', 'facts', true],
    ["What's the train schedule?", 'facts', true],
    ['Is it cold outside?', 'facts', true],
    ['did you see the game last night', 'facts', true],
    // The time and date come from the clock, not the web.
    ['What time is it?', 'facts', false],

    // Small talk: no search.
    ['How was your day?', 'smalltalk', false],
    ['Hi! How are you?', 'smalltalk', false],
    ['Good morning!', 'smalltalk', false],
    ['Thanks for coming today.', 'smalltalk', false],
    ["Nice weather today, isn't it?", 'smalltalk', false],
    ['Did you have fun at the party?', 'smalltalk', false],
    ['Really?', 'smalltalk', false],
    ["Hey Sam, how's it going?", 'smalltalk', false],
    ["How's everyone doing?", 'smalltalk', false],
    ['', 'smalltalk', false],

    // Personal: memory answers, no search.
    ['Are you tired?', 'personal', false],
    ['Do you want water?', 'personal', false],
    ['Want some water?', 'personal', false],
    ['Are you comfortable?', 'personal', false],
    ['Do you need the bathroom?', 'personal', false],
    ['Is the TV too loud?', 'personal', false],
    ["How's Sarah doing?", 'personal', false],
    ['Is Dr. Lee coming today?', 'personal', false],
    ['Did your mom call?', 'personal', false],
    ['Should I open the window?', 'personal', false],
    ['How did you sleep?', 'personal', false],
    ['Do you remember our trip to Tahoe?', 'personal', false],
    ["What's your schedule today?", 'personal', false],
    ['How many hours did you sleep?', 'personal', false],
    ['Should we leave now?', 'personal', false],
    // Lowercase, as a transcript without capitals: no name to spot, the frame still says personal.
    ['how is sarah doing', 'personal', false],
    ['are you cold', 'personal', false],
];

describe('classifyQuestion', () => {
    it('has at least 30 cases covering all four kinds', () => {
        assert.ok(CASES.length >= 30);
        for (const kind of ['places', 'facts', 'smalltalk', 'personal'] as const) {
            assert.ok(CASES.filter((c) => c[1] === kind).length >= 5, kind);
        }
    });

    for (const [question, kind, needsWeb] of CASES) {
        it(`${JSON.stringify(question)} is ${kind}, needsWeb ${needsWeb}`, () => {
            const got = classifyQuestion(question);
            assert.deepEqual({ kind: got.kind, needsWeb: got.needsWeb }, { kind, needsWeb }, got.reason);
        });
    }

    it('searches when no rule is sure, and says so', () => {
        const got = classifyQuestion('What happened?');
        assert.equal(got.needsWeb, true);
        assert.match(got.reason, /^Not sure/);
    });

    it('treats a name it cannot place as a lookup', () => {
        const got = classifyQuestion('Did you see Dune?');
        assert.equal(got.needsWeb, true);
        assert.match(got.reason, /name/);
    });

    it('never quotes the question in its reason', () => {
        for (const question of ["How's Sarah doing?", 'Is Chez Panisse open on Sunday?', 'Did you see Dune?', 'What happened?']) {
            const { reason } = classifyQuestion(question);
            for (const word of ['Sarah', 'Chez', 'Panisse', 'Dune', 'happened']) assert.ok(!reason.includes(word), `${reason} / ${word}`);
        }
    });

    it('ignores curly quotes, accents and odd spacing', () => {
        const quote = String.fromCharCode(0x2019);
        const eAcute = String.fromCharCode(0x00e9);
        assert.equal(classifyQuestion(`Is the caf${eAcute}  open${quote} now?`).kind, 'places');
        assert.equal(classifyQuestion(`What${quote}s the weather like?`).kind, 'facts');
        assert.equal(classifyQuestion(undefined as unknown as string).reason, 'Empty question, nothing to look up.');
    });

    describe('with fetch disabled', () => {
        let saved: typeof globalThis.fetch;
        before(() => {
            saved = globalThis.fetch;
            globalThis.fetch = () => {
                throw new Error('classifyQuestion must not touch the network');
            };
        });
        after(() => {
            globalThis.fetch = saved;
        });

        it('runs every case without a network call, quickly', () => {
            const started = performance.now();
            for (let round = 0; round < 20; round++) for (const [question] of CASES) classifyQuestion(question);
            const perCall = (performance.now() - started) / (20 * CASES.length);
            assert.ok(perCall < 1, `${perCall.toFixed(3)} ms per call`);
        });
    });
});
