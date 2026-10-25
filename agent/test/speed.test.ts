// The speed changes: the yes or no fast path (src/fastpath.ts) and draft first (src/jobs.ts, AGENT_DRAFT_FIRST).

import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { ApifyHttpError } from '@say-when/apify-client';

import { readConfig } from '../src/config.js';
import { classifyYesNo, stockYesNo } from '../src/fastpath.js';
import { validatePlan } from '../src/planner/validate.js';
import type { CallContact } from '../src/types.js';
import { fourOptions, harness, memoryHit, reply, settle, waitFor, yesNo, type Harness } from './helpers.js';

/** A consented call contact for the draft tests. */
const CARE_TEAM: CallContact = { contactId: 'care_team', name: 'the care team' };

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
    'Would you like to go outside?',
    'Shall we go?',
    'Have you eaten yet?',
    'Had you met her before?',
    'May I sit here?',
    'Might you be cold?',
    '  ARE YOU OK?  ',
    '“Are you cold?”',
    'Smoke test: tired? [yes_no]',
    'Smoke test: tea or coffee? [yes_no]',
    // True yes or no questions that must stay fast after the request and errand rules (review round 1).
    'Do you want water?',
    'Are you cold?',
    'Is the Berkeley Public Library open on Sunday?',
    'Are you able to hear me?',
    'Have you slept?',
    'Did you eat lunch?',
    'Do you want me to stay?',
    'Can you see me?',
    'Are you feeling okay?',
    'Are you coming?',
    'Is Sam here?',
    // Review round 2: offers to rest, go or sit stay fast.
    'Do you want to go outside?',
    'Would you like to rest now?',
];

const NEGATIVES: [string, string][] = [
    ['Tea or coffee?', 'no_auxiliary'],
    ['Do you want tea or coffee?', 'choice'],
    ['Would you rather walk, or take the bus?', 'choice'],
    ['Do you want either one?', 'choice'],
    // Review round 1: requests and choices the planner could turn into an option, never stock Yes and No.
    ['Can you pick between tea and coffee?', 'choice'],
    ['Would you rather stay inside?', 'choice'],
    ['Can you choose one for me?', 'choice'],
    ['Could you call the pharmacy about the request?', 'errand_verb'],
    ['Can you send the care team a request?', 'errand_verb'],
    ['Should I call the nurse?', 'errand_verb'],
    ['Has the nurse called?', 'errand_verb'],
    ['Do you want to order lunch?', 'errand_verb'],
    ['Did you text your mom?', 'errand_verb'],
    ['Do you want me to book a table?', 'errand_verb'],
    ['Can you remind me later?', 'errand_verb'],
    ['Will you fill out the form?', 'errand_verb'],
    ['Was the email sent?', 'errand_verb'],
    ['Would you mind opening the window?', 'request'],
    ['Can you please help me?', 'request'],
    ['Could you hand me the cup?', 'request'],
    ['Will you tell the nurse?', 'errand_verb'],
    // Review round 2 (Codex): an offer to act, or a request named as a noun, never stock Yes and No.
    ['Do you want to submit a care team request?', 'errand_verb'],
    ['Do you want me to get the nurse?', 'errand_verb'],
    ['Would you like me to ask the nurse for a blanket?', 'errand_verb'],
    ['Should I bring your glasses?', 'errand_verb'],
    ['Do you want me to open the window?', 'request'],
    ['Shall I turn on the lights?', 'request'],
    ['Can I help you with anything?', 'open_ended'],
    ['Can I help you with the cup?', 'request'],
    // Review round 4 (Codex): "be" after "would/could you" and "able to" are requests for content.
    ['Would you be able to describe your pain?', 'request'],
    ['Could you be more specific?', 'request'],
    ['Are you able to describe it?', 'request'],
    ['Would you be cold outside?', 'request'],
    // Review round 5 (Codex): a safe first verb must not approve the sentence. Compounds, content requests and any
    // main verb off the plain yes or no list go to the planner.
    ['Can you hear me and say your name?', 'compound'],
    ['Do you mind describing your pain?', 'request'],
    ['Are you saying no?', 'request'],
    ['Do you prefer the window seat?', 'main_verb'],
    ['Did you finish the soup?', 'main_verb'],
    ['Does your back hurt?', 'main_verb'],
    ['Will it rain tomorrow?', 'main_verb'],
    // Found while preparing round 6: the same rule after have, has and had.
    ['Have you decided on lunch?', 'main_verb'],
    ['Has it stopped raining?', 'main_verb'],
    // Review round 6 (Codex): an approved verb must not carry a request after it. Every "to" verb is checked, the
    // words after the main verb are few and have no particle ("come up with"), and the question is short.
    ['Can you come up with a name for the baby?', 'request'],
    ['Do you care to elaborate on your pain?', 'request'],
    ['Are you going to the store?', 'request'],
    ['Do you feel like talking about it?', 'main_verb'],
    ['Do you need help getting up?', 'errand_verb'],
    ['Do you want to sit up?', 'main_verb'],
    ['Do you want the big red cup now?', 'main_verb'],
    // Found while preparing round 7: "is there" asks what there is, and be + pronoun + a verb in -ing is checked too.
    ['Is there a name you like for the baby?', 'open_ended'],
    ['Are there any questions?', 'open_ended'],
    ['Are you thinking of a word?', 'main_verb'],
    // Review round 7 (Codex): a second bare verb ("come help", "come read") and hyphenated alternatives. The fast
    // path now takes only words from a closed list (plus names after is, are, was, were), and a verb after the
    // main one only right after "to".
    ['Can you come help me?', 'request'],
    ['Can you come read this?', 'request'],
    ['Is it okay to come read this?', 'request'],
    ['Would you like to go sit?', 'second_verb'],
    ['Is it okay to go rest?', 'second_verb'],
    ['Is your pain mild-moderate-severe?', 'list'],
    ['Can you hear Sam?', 'request'],
    ['Do you want Sam here?', 'vocabulary'],
    ['Is the soup spicy?', 'vocabulary'],
    // Review round 8 (Codex): "move" asks for an action on a thing; so do come, read, watch, play, try, walk, talk and
    // listen. They left the plain verb lists.
    ['Could you move my chair?', 'request'],
    ['Can you move the bed?', 'request'],
    ['Would you move the car?', 'request'],
    ['Will you come with us?', 'request'],
    ['Could you read this?', 'request'],
    ['Can you watch the baby?', 'request'],
    ['Should I read to you?', 'request'],
    ['Should I read now?', 'request'],
    ['Do you want me to watch?', 'request'],
    // Found while preparing round 9: eat, drink and swallow asked of the person are requests too.
    ['Could you drink the water?', 'request'],
    ['Can you eat the soup?', 'request'],
    ['Would you like to eat now?', 'request'],
    // Review round 9 (Codex): a clinician's "Could you breathe in for me?" is an instruction. Only hear, see, feel,
    // like, want, need and understand stay after "can/could/would/will you".
    ['Could you breathe in for me?', 'request'],
    ['Could you sleep last night?', 'request'],
    ['Would you like to sleep?', 'request'],
    // Review round 10 (Codex): "Could you feel the water for me?" asks for a favor. "can/could/would/will you" now
    // stays fast only as "would you like ..." or "can/could you hear/see me"; anything "for me" or "for us" is a favor.
    ['Could you feel the water for me?', 'request'],
    ['Can you see the screen from there?', 'request'],
    ['Can you hear the music?', 'request'],
    ['Is it warm enough for me?', 'request'],
    ['Can you come up with one?', 'request'],
    ['Is the big pharmacy near the old train station still open today?', 'long'],
    // Review round 3 (Codex): a list of alternatives, with commas or slashes, is a choice for the planner.
    ['Is your pain mild/moderate/severe?', 'list'],
    ['Do you prefer tea, coffee, juice?', 'list'],
    ['Would you like tea & toast?', 'list'],
    ['Are you okay, Sam?', 'list'],
    // Found while preparing round 4: questions that ask for information or leave the need open.
    ['Do you know if the store is open?', 'wh_word'],
    ['Is it okay if I sit here?', 'wh_word'],
    ["Do you know the doctor's name?", 'knowledge'],
    ['Do you remember the restaurant we went to?', 'knowledge'],
    ['Do you need anything?', 'open_ended'],
    ['Is there something you want?', 'open_ended'],
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
    ['Are you tired? Do you want to sleep?', 'request'],
    ['Are you tired? Do you want to rest?', 'several_sentences'],
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
            options.map((o) => [o.kind, o.label, o.text, o.provenance, o.actionJson, o.sources.length, o.memoryRefs.length]),
            [
                ['reply', 'Yes', 'Yes.', 'stock', '', 0, 0],
                ['reply', 'No', 'No.', 'stock', '', 0, 0],
            ],
        );
        const plan = validatePlan(
            {
                answer_mode: 'yes_no',
                options: options.map((o) => ({ kind: 'reply' as const, label: o.label, text: o.text, query: '', tone: o.tone || 'neutral', laugh: o.laugh, sources: [], errand: null, call: null })),
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
        assert.match(h.log.text(), /yes or no fast path not taken job=\d+ why=choice/);
    });

    it('leaves a request for an errand or a call to the planner, so the person can pick the action itself', async () => {
        const h = start(harness({ yesNoFast: true }));
        h.api.reply(fourOptions());
        const jobId = h.db.addOptionsJob({ questionText: 'Can you send the care team a request?' });
        await waitFor(() => h.db.job(jobId)?.status === 'done');
        assert.equal(h.api.calls.length, 1, 'Claude writes the options');
        assert.ok(h.db.publishes.every((p) => p.options.every((o) => o.provenance !== 'stock')));
        assert.match(h.log.text(), /yes or no fast path not taken job=\d+ why=errand_verb/);
    });

    it('leaves a yes or no question to the planner while a call about a recent errand is possible (review round 4)', async () => {
        const h = start(harness({ yesNoFast: true, contacts: [CARE_TEAM] }));
        h.api.reply(yesNo());
        const jobId = h.db.addOptionsJob({ questionText: 'Are you tired?', recentErrandTitle: 'Care team request', recentErrandSentAtMs: Date.now() - 30_000 });
        await waitFor(() => h.db.job(jobId)?.status === 'done');
        assert.equal(h.api.calls.length, 1, 'Claude writes the options, and can offer the call');
        assert.match(h.api.userMessage(0), /Contacts for a call:\n/);
        assert.match(h.log.text(), /yes or no fast path not taken job=\d+ why=call_possible/);
    });

    it('still answers at once when the recent errand is too old for a call (the control)', async () => {
        const h = start(harness({ yesNoFast: true, contacts: [CARE_TEAM] }));
        const jobId = h.db.addOptionsJob({ questionText: 'Are you tired?', recentErrandTitle: 'Care team request', recentErrandSentAtMs: Date.now() - 9 * 60_000 });
        await waitFor(() => h.db.job(jobId)?.status === 'done');
        assert.equal(h.api.calls.length, 0);
        assert.equal(h.db.publishes[0]?.options[0]?.provenance, 'stock');
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
        const h = start(harness({ draftFirst: true, contacts: [CARE_TEAM] }));
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

    it('does not make a yes or no draft final while a call about a recent errand is possible (review round 4)', async () => {
        const h = start(harness({ draftFirst: true, contacts: [CARE_TEAM] }));
        const release = h.search.hold();
        h.api.reply(yesNo());
        h.api.reply({
            answer_mode: 'pick',
            options: [
                reply({ text: 'Not now.', tone: 'calm' }),
                { text: 'Call the care team about it.', kind: 'call', tone: 'warm', laugh: false, sources: [], errand: null, call: { contact_id: 'care_team' } },
            ],
        });
        const jobId = h.db.addOptionsJob({ questionText: 'Is the pharmacy request done yet?', recentErrandTitle: 'Care team request', recentErrandSentAtMs: Date.now() - 30_000 });
        await waitFor(() => h.api.calls.length === 1, 3_000, 'draft asked');
        await settle(50);
        assert.equal(h.db.publishes.length, 0, 'the yes or no draft is not published');
        assert.ok(!eventDetails(h).includes('search ok search stopped'), 'the search goes on');
        release();
        await waitFor(() => h.db.job(jobId)?.status === 'done', 3_000, 'job done');
        assert.equal(h.db.publishes.length, 1);
        assert.deepEqual(h.db.publishes[0]?.options.map((o) => o.kind), ['reply', 'call']);
    });

    it('plans again instead of keeping the draft when a call is possible, even if the search brought nothing', async () => {
        // Review round 1 (Codex): the draft never sees contacts or the recent errand, so keeping it lost the call option.
        const h = start(harness({ draftFirst: true, contacts: [CARE_TEAM] }));
        h.search.rows = [];
        const release = h.search.hold();
        h.api.reply(picks(['Not sure yet.', 'Not now.']));
        h.api.reply({
            answer_mode: 'pick',
            options: [
                reply({ text: 'Not now.', tone: 'calm' }),
                { text: 'Call the care team about it.', kind: 'call', tone: 'warm', laugh: false, sources: [], errand: null, call: { contact_id: 'care_team' } },
            ],
        });
        const jobId = h.db.addOptionsJob({ questionText: 'Who can you call about the pharmacy request?', recentErrandTitle: 'Care team request', recentErrandSentAtMs: Date.now() - 30_000 });
        await waitFor(() => h.db.publishes.length === 1, 3_000, 'draft published');
        release();
        await waitFor(() => h.db.job(jobId)?.status === 'done', 3_000, 'job done');
        assert.equal(h.api.calls.length, 2, 'the normal plan ran');
        const final = h.db.publishes.at(-1);
        assert.equal(final?.final, true);
        assert.deepEqual(final?.options.map((o) => o.kind), ['reply', 'call']);
        assert.ok(!eventDetails(h).includes('plan ok draft kept'));
    });

    it('still keeps the draft when the search brought nothing and no call is possible (the control)', async () => {
        const h = start(harness({ draftFirst: true, contacts: [CARE_TEAM] }));
        h.search.rows = [];
        const release = h.search.hold();
        h.api.reply(picks(['Not sure yet.', 'Not now.']));
        const jobId = h.db.addOptionsJob({ questionText: 'Who can you call about the pharmacy request?' });
        await waitFor(() => h.db.publishes.length === 1, 3_000, 'draft published');
        release();
        await waitFor(() => h.db.job(jobId)?.status === 'done', 3_000, 'job done');
        assert.equal(h.api.calls.length, 1);
        assert.ok(eventDetails(h).includes('plan ok draft kept'));
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

    it('leaves draft first off by default (review round 2), and turns it on with AGENT_DRAFT_FIRST=on', () => {
        // The module ends a question with no pick when the draft's passes run out, and cancels the job, even while
        // the final plan with web results is still on its way; until the module waits for it, the draft is opt-in.
        assert.equal(readConfig(base, tokenFile).config.speed.draftFirst, false);
        assert.equal(readConfig({ ...base, AGENT_DRAFT_FIRST: 'on' }, tokenFile).config.speed.draftFirst, true);
    });
});
