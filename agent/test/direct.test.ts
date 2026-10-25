// Direct select (docs/direct-select.md, PLAN D18) on the sidecar's side: the earpiece label, the Search option, the
// categories job and the category search job, over the fakes (no network, no keys).

import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import Anthropic from '@anthropic-ai/sdk';

import { readConfig } from '../src/config.js';
import { ContractError, toAgentQueueRow } from '../src/db/spacetime-db.js';
import { asksDoYouKnow, CategoryBook, defaultCategoryQuery, DO_YOU_KNOW_REASON, placeHint, STOCK_SEARCH, stockCategories, withSearch } from '../src/direct.js';
import { ClaudePlanner } from '../src/planner/claude.js';
import { buildUserMessage, SYSTEM_PROMPT } from '../src/planner/prompt.js';
import type { PlanReply } from '../src/planner/schema.js';
import { PlannerError, type PlanInput } from '../src/planner/types.js';
import { validatePlan } from '../src/planner/validate.js';
import type { OptionInput } from '../src/types.js';
import { DEMO_FORM, FakeApi, harness, LEON, memoryHit, placeRow, reply, SECRET, waitFor, webRow, type Harness, type HarnessOptions } from './helpers.js';

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

/** A direct select sidecar with three options, as on `say-when-direct` (D23, AGENT_MAX_OPTIONS=3). */
function startThree(options: HarnessOptions = {}): Harness {
    const h = harness({ direct: true, ...options });
    h.deps.maxOptions = 3;
    return start(h);
}

const finalPublish = (h: Harness) => h.db.publishes.find((p) => p.final);
const eventsOf = (h: Harness, stage: string) => h.db.events.filter((e) => e.stage === stage);
const FUN_QUESTION = 'Anything you want to do today in San Francisco?';

function input(overrides: Partial<PlanInput> = {}): PlanInput {
    return {
        question: FUN_QUESTION,
        origin: 'partner',
        menuItem: 'none',
        history: [],
        memory: [],
        web: [
            {
                ref: 'w1',
                kind: 'maps',
                title: 'Palace of Fine Arts',
                text: 'Landmark. Open when checked.',
                score: 0.9,
                source: { source: 'maps', url: 'https://maps.example.com/?cid=1', placeId: 'place1', fetchedAt: '2026-10-24T19:00:00.000Z' },
            },
            {
                ref: 'w2',
                kind: 'web',
                title: 'Things to do',
                text: 'A list of ideas.',
                score: 0.7,
                source: { source: 'web', url: 'https://example.com/ideas', placeId: undefined, fetchedAt: '2026-10-24T19:00:00.000Z' },
            },
        ],
        forms: [],
        contacts: [],
        recentErrand: null,
        search: 'not_needed',
        task: 'options',
        maxOptions: 4,
        nowMs: Date.parse('2026-10-24T20:05:00Z'),
        timeZone: 'America/Los_Angeles',
        ...overrides,
    };
}

const problemsOf = (reply: PlanReply, given: PlanInput): string[] => {
    try {
        validatePlan(reply, given);
        return [];
    } catch (error) {
        assert.ok(error instanceof PlannerError && error.code === 'invalid_reply');
        return [...error.problems];
    }
};

/** Yes-style, no-style, the search option, something else: the shape for a question that could use outside facts. */
function withSearchReply(): PlanReply {
    return {
        answer_mode: 'pick',
        options: [
            reply({ label: 'Sure', text: 'Sure, I would love to go out.', tone: 'warm' }),
            reply({ label: 'Not today', text: 'Not today, I am tired.', tone: 'calm' }),
            reply({ kind: 'search', label: 'Search the web', text: 'Search the web for ideas.', tone: 'neutral' }),
            reply({ label: 'You pick', text: 'You pick, I am easy.', tone: 'firm' }),
        ],
    };
}

function categoriesReply(): PlanReply {
    return {
        answer_mode: 'pick',
        options: [
            reply({ kind: 'category', label: 'Nature', text: 'Parks and gardens.', query: 'hiking trails in San Francisco' }),
            reply({ kind: 'category', label: 'Fun', text: 'Something fun.', query: 'arcades and museums in San Francisco' }),
            reply({ kind: 'category', label: 'Thrill', text: 'Something thrilling.', query: 'thrilling activities in San Francisco' }),
            reply({ kind: 'category', label: 'Something else', text: 'Something else.', query: 'things to do in San Francisco today' }),
        ],
    };
}

describe('the direct select planner', () => {
    it('asks for a label, search words and the search and category kinds in its one fixed schema', () => {
        const params = new ClaudePlanner({ api: new FakeApi() }).request(input());
        const schema = params.output_config?.format?.schema as { properties: { options: { items: { required: string[]; properties: { kind: unknown } } } } };
        const item = schema.properties.options.items;
        for (const field of ['label', 'query']) assert.ok(item.required.includes(field), field);
        // The SDK helper writes a string enum into the description.
        for (const kind of ['reply', 'errand', 'call', 'search', 'category']) assert.ok(JSON.stringify(item.properties.kind).includes(kind), kind);
        assert.match(SYSTEM_PROMPT, /label is what the earpiece reads: 1 to 3 words/);
        assert.match(SYSTEM_PROMPT, /3 a search option \(kind "search", label "Search the web"/);
        assert.match(SYSTEM_PROMPT, /Offer categories\./);
        assert.match(SYSTEM_PROMPT, /label "Palace of Fine Arts" with text "Let's go to the Palace of Fine Arts!"/);
        assert.match(SYSTEM_PROMPT, /Use only the question for the query: never memory/);
    });

    it('names the task first in the message, and leaves the scan message as it was', () => {
        assert.match(buildUserMessage(input({ searchOffer: true, search: 'offered' })), /Task: answer the question\. A web search can be offered as option 3\./);
        assert.match(buildUserMessage(input({ searchOffer: true, search: 'offered' })), /A web search can be offered: put the search option third\./);
        assert.match(buildUserMessage(input()), /Task: answer the question\. No search option\./);
        // "Do you know" (D24): the search ran, so the replies come from its results; without results, the plain offer.
        assert.match(
            buildUserMessage(input({ searchOffer: true, searchedNow: true, search: 'done' })),
            /Task: answer the question\. The partner asked "do you know", so the web search already ran: write the replies from the web results below, and put a new search option third\./,
        );
        assert.match(buildUserMessage(input({ searchOffer: true, searchedNow: true, search: 'failed', web: [] })), /Task: answer the question\. A web search can be offered as option 3\./);
        assert.match(SYSTEM_PROMPT, /search already ran because the partner asked "do you know", write the replies from the web results/);
        assert.match(buildUserMessage(input({ task: 'categories' })), /Task: offer categories\./);
        assert.match(buildUserMessage(input({ task: 'category_search', category: 'Nature' })), /Task: replies from the search\. The person picked the category "Nature"\./);
        assert.doesNotMatch(buildUserMessage(input({ task: undefined })), /Task:/);
    });

    it('refuses an earpiece label that is long, empty or the same as another, and lets a place name run to five words', () => {
        const two = (a: Partial<ReturnType<typeof reply>>, b: Partial<ReturnType<typeof reply>>): PlanReply => ({
            answer_mode: 'pick',
            options: [reply({ text: 'First one.', tone: 'warm', ...a }), reply({ text: 'Second one.', tone: 'calm', ...b })],
        });
        assert.ok(problemsOf(two({ label: 'I am doing great' }, {}), input()).includes('label_too_long'));
        assert.ok(problemsOf(two({ label: '' }, {}), input()).includes('empty_label'));
        assert.ok(problemsOf(two({ label: 'Good' }, { label: 'good' }), input()).includes('duplicate_label'));
        assert.ok(problemsOf(two({ label: 'x'.repeat(41) }, {}), input()).includes('label_too_long'));
        // A place's name, citing the place: up to five words. The same words without the place are too long.
        assert.deepEqual(problemsOf(two({ label: 'The Palace of Fine Arts', sources: ['w1'] }, {}), input()), []);
        assert.ok(problemsOf(two({ label: 'The Palace of Fine Arts', sources: ['w2'] }, {}), input()).includes('label_too_long'));
        const plan = validatePlan(two({ label: '  Good  ' }, {}), input());
        assert.equal(plan.options[0]?.label, 'Good');
    });

    it('refuses a reply longer than one short sentence', () => {
        const long = Array.from({ length: 21 }, (_, i) => `word${i}`).join(' ');
        assert.ok(problemsOf({ answer_mode: 'pick', options: [reply({ label: 'Long', text: long })] }, input()).includes('text_too_long'));
    });

    it('takes a search option only when one is offered, once, with no source or action, and never in yes_no mode', () => {
        assert.ok(problemsOf(withSearchReply(), input()).includes('search_not_offered'));
        assert.deepEqual(problemsOf(withSearchReply(), input({ searchOffer: true })), []);
        const twice = withSearchReply();
        twice.options[3] = reply({ kind: 'search', label: 'Look it up', text: 'Look it up online.', tone: 'firm' });
        assert.ok(problemsOf(twice, input({ searchOffer: true })).includes('duplicate_search'));
        const sourced = withSearchReply();
        sourced.options[2] = { ...sourced.options[2]!, sources: ['w2'] };
        assert.ok(problemsOf(sourced, input({ searchOffer: true })).includes('search_with_source'));
        const yesNo: PlanReply = { answer_mode: 'yes_no', options: [reply({ label: 'Yes', text: 'Yes.', tone: 'warm' }), reply({ kind: 'search', label: 'Search the web', text: 'Search the web.', tone: 'calm' })] };
        assert.ok(problemsOf(yesNo, input({ searchOffer: true })).includes('action_in_yes_no'));
        // A search is never the only option.
        assert.ok(problemsOf({ answer_mode: 'pick', options: [withSearchReply().options[2]!] }, input({ searchOffer: true })).includes('only_actions'));
    });

    it('takes only categories with clean search words in the categories task, and none anywhere else', () => {
        const plan = validatePlan(categoriesReply(), input({ task: 'categories', web: [] }));
        assert.deepEqual(
            plan.options.map((o) => [o.kind, o.label, o.query]),
            [
                ['category', 'Nature', 'hiking trails in San Francisco'],
                ['category', 'Fun', 'arcades and museums in San Francisco'],
                ['category', 'Thrill', 'thrilling activities in San Francisco'],
                ['category', 'Something else', 'things to do in San Francisco today'],
            ],
        );
        const categories = (change: (r: PlanReply) => void): string[] => {
            const r = categoriesReply();
            change(r);
            return problemsOf(r, input({ task: 'categories', web: [] }));
        };
        assert.ok(categories((r) => (r.options[0] = reply({ label: 'Sure', text: 'Sure.' }))).includes('not_a_category'));
        assert.ok(categories((r) => (r.options[0] = { ...r.options[0]!, query: 'call 4155550199' })).includes('bad_category_query'));
        assert.ok(categories((r) => (r.options[0] = { ...r.options[0]!, query: '' })).includes('bad_category_query'));
        assert.ok(categories((r) => (r.options[0] = { ...r.options[0]!, query: 'parks [and] gardens' })).includes('bad_category_query'));
        assert.ok(categories((r) => (r.options[0] = { ...r.options[0]!, sources: ['w1'] })).includes('category_with_source'));
        assert.ok(categories((r) => (r.options = r.options.slice(0, 1))).includes('option_count'));
        assert.ok(problemsOf({ ...categoriesReply(), answer_mode: 'yes_no', options: categoriesReply().options.slice(0, 2) }, input({ task: 'categories' })).includes('categories_need_pick'));
        // A category outside the categories task: its pick would start a search with no confirm.
        const sneaky: PlanReply = { answer_mode: 'pick', options: [reply({ text: 'Okay.', tone: 'warm' }), categoriesReply().options[0]!] };
        assert.ok(problemsOf(sneaky, input()).includes('category_not_allowed'));
        assert.ok(problemsOf(sneaky, input({ task: 'category_search' })).includes('not_a_reply'));
    });

    it('takes only replies, in pick mode, for the search results', () => {
        const results: PlanReply = {
            answer_mode: 'pick',
            options: [
                reply({ label: 'Palace of Fine Arts', text: "Let's go to the Palace of Fine Arts!", sources: ['w1'], tone: 'warm' }),
                reply({ label: 'Something else', text: 'Something else, please.', tone: 'calm' }),
            ],
        };
        assert.equal(validatePlan(results, input({ task: 'category_search', category: 'Nature' })).options[0]?.label, 'Palace of Fine Arts');
        const withSearch: PlanReply = { ...results, options: [...results.options, withSearchReply().options[2]!] };
        assert.ok(problemsOf(withSearch, input({ task: 'category_search', searchOffer: true })).includes('not_a_reply'));
        assert.ok(problemsOf({ answer_mode: 'yes_no', options: results.options }, input({ task: 'category_search' })).includes('results_need_pick'));
    });
});

describe('the Search option in the list', () => {
    const opt = (text: string, kind: OptionInput['kind'] = 'reply'): OptionInput => ({ ...STOCK_SEARCH, kind, label: text, text, provenance: 'model' });

    it('is third: yes-style, no-style, Search the web, something else', () => {
        const { answerMode, options, added } = withSearch([opt('Sure'), opt('No'), opt('Else'), opt('Look it up', 'search')], 4);
        assert.equal(answerMode, 'pick');
        assert.deepEqual(options.map((o) => o.text), ['Sure', 'No', 'Look it up', 'Else']);
        assert.equal(added, false);
    });

    it('is added when the planner left it out, keeping three replies, and turns a yes or no plan into a pick', () => {
        const four = withSearch([opt('A'), opt('B'), opt('C'), opt('D')], 4);
        assert.deepEqual(four.options.map((o) => [o.kind, o.label]), [['reply', 'A'], ['reply', 'B'], ['search', 'Search the web'], ['reply', 'C']]);
        assert.equal(four.added, true);
        const yesNo = withSearch([opt('Yes'), opt('No')], 4);
        assert.deepEqual(yesNo.options.map((o) => o.label), ['Yes', 'No', 'Search the web']);
        // One reply is filled up with a stock reply (as D22 does), so the Search option is still third.
        const only = withSearch([opt('Only')], 3);
        assert.deepEqual(only.options.map((o) => [o.kind, o.label, o.provenance]), [['reply', 'Only', 'model'], ['reply', 'Not now', 'stock'], ['search', 'Search the web', 'stock']]);
    });

    it('is always third in a three-option list, after a reply and the errand or the call (D24)', () => {
        const three = (options: OptionInput[]) => withSearch(options, 3).options.map((o) => [o.kind, o.label]);
        assert.deepEqual(three([opt('A'), opt('B'), opt('C')]), [['reply', 'A'], ['reply', 'B'], ['search', 'Search the web']]);
        assert.deepEqual(three([opt('A'), opt('B'), opt('Send request', 'errand')]), [['reply', 'A'], ['errand', 'Send request'], ['search', 'Search the web']]);
        assert.deepEqual(three([opt('Send request', 'errand'), opt('A'), opt('B')]), [['reply', 'A'], ['errand', 'Send request'], ['search', 'Search the web']]);
        assert.deepEqual(three([opt('Look it up', 'search'), opt('A'), opt('Call Leon', 'call')]), [['reply', 'A'], ['call', 'Call Leon'], ['search', 'Look it up']]);
        for (const list of [[opt('A')], [opt('A'), opt('B')], [opt('A'), opt('B'), opt('C'), opt('D')], [opt('Call Leon', 'call'), opt('A'), opt('B'), opt('C')]]) {
            const out = withSearch(list, 3).options;
            assert.equal(out.length, 3);
            assert.equal(out[2]?.kind, 'search', 'rank 3 is the Search option');
            assert.equal(out.filter((o) => o.kind === 'search').length, 1);
        }
    });
});

describe('the "do you know" trigger (D24)', () => {
    it('matches "do you know" and "d\'you know" in any case, as whole words only', () => {
        for (const q of ['Do you know who won last night?', 'so, DO YOU KNOW if it is open?', "D'you know where it is?", 'D’you know the way?', 'Do you  know the score?', 'Where is it, do you know?']) {
            assert.equal(asksDoYouKnow(q), true, q);
        }
        for (const q of ['Did you know that?', 'You know what?', "I don't know.", 'Do you knowledge it?', 'Undo you know nothing', 'Who won last night?']) {
            assert.equal(asksDoYouKnow(q), false, q);
        }
    });
});

describe('the direct select options job', () => {
    it('answers small talk with replies and their labels, offers Search the web third (D24), and never searches', async () => {
        const h = startThree();
        h.api.reply({
            answer_mode: 'pick',
            options: [
                reply({ label: 'Good', text: "I'm doing awesome, how about you?", tone: 'warm' }),
                reply({ label: 'Not great', text: 'Not great, long day.', tone: 'sad' }),
                reply({ label: 'Tired', text: 'A little tired, honestly.', tone: 'calm' }),
            ],
        });
        const jobId = h.db.addOptionsJob({ questionText: 'Hey, how are you?' });
        await waitFor(() => h.db.job(jobId)?.status === 'done');
        const published = finalPublish(h);
        assert.equal(published?.answerMode, 'pick');
        assert.deepEqual(published?.options.map((o) => [o.kind, o.label, o.text]), [
            ['reply', 'Good', "I'm doing awesome, how about you?"],
            ['reply', 'Not great', 'Not great, long day.'],
            ['search', 'Search the web', 'Search the web for ideas.'],
        ]);
        assert.equal(h.search.calls.length, 0);
        // One search event, the offer, which still says the question itself needs no outside facts.
        const search = eventsOf(h, 'search');
        assert.deepEqual(search.map((e) => [e.status, e.detail]), [['ok', 'offered']]);
        assert.equal(JSON.parse(search[0]?.countsJson ?? '{}').needsWeb, false);
        assert.match(h.api.userMessage(), /Task: answer the question\. A web search can be offered as option 3\./);
    });

    it('offers Search the web third for a question that could use outside facts, without searching', async () => {
        const h = start(harness({ direct: true }));
        h.memory.order = ['o4', 'o3', 'o2', 'o1'];
        h.api.reply(withSearchReply());
        const jobId = h.db.addOptionsJob({ questionText: FUN_QUESTION });
        await waitFor(() => h.db.job(jobId)?.status === 'done');
        const published = finalPublish(h);
        assert.equal(published?.answerMode, 'pick');
        assert.deepEqual(published?.options.map((o) => [o.kind, o.label]), [
            ['reply', 'Sure'],
            ['reply', 'Not today'],
            ['search', 'Search the web'],
            ['reply', 'You pick'],
        ]);
        assert.equal(published?.options[2]?.actionJson, '');
        assert.equal(h.search.calls.length, 0, 'nothing is searched before the person asks');
        assert.equal(h.web.indexed.size, 0);
        assert.equal(h.memory.ranked.length, 0, 'memory never reorders a list with a search option');
        const search = eventsOf(h, 'search');
        assert.deepEqual(search.map((e) => [e.status, e.detail]), [['ok', 'offered']]);
        assert.match(h.api.userMessage(), /A web search can be offered as option 3\./);
    });

    it('adds the stock Search option when the planner leaves it out, and makes a yes or no answer a pick', async () => {
        const h = start(harness({ direct: true }));
        h.api.reply({
            answer_mode: 'yes_no',
            options: [reply({ label: 'Yes', text: 'Yes, I would like that.', tone: 'warm' }), reply({ label: 'No', text: 'No, not today.', tone: 'calm' })],
        });
        const jobId = h.db.addOptionsJob({ questionText: FUN_QUESTION });
        await waitFor(() => h.db.job(jobId)?.status === 'done');
        const published = finalPublish(h);
        assert.equal(published?.answerMode, 'pick');
        assert.deepEqual(published?.options.map((o) => [o.kind, o.label, o.provenance]), [
            ['reply', 'Yes', 'model'],
            ['reply', 'No', 'model'],
            ['search', 'Search the web', 'stock'],
        ]);
        assert.ok(h.log.entries.some((e) => e.message === 'options published' && e.fields.searchAdded === true));
    });

    it('offers no Search option and runs no search without web search consent, "do you know" included', async () => {
        const h = startThree();
        h.db.consent.webSearch = false;
        const replies = () => ({ answer_mode: 'pick' as const, options: withSearchReply().options.filter((o) => o.kind === 'reply').slice(0, 3) });
        h.api.reply(replies());
        const noConsent = h.db.addOptionsJob({ questionText: FUN_QUESTION });
        await waitFor(() => h.db.job(noConsent)?.status === 'done');
        assert.match(h.api.userMessage(0), /No search option\./);
        assert.ok(finalPublish(h)?.options.every((o) => o.kind === 'reply'));

        h.api.reply(replies());
        const knows = h.db.addOptionsJob({ questionText: 'Do you know who won the Giants game last night?' });
        await waitFor(() => h.db.job(knows)?.status === 'done');
        assert.match(h.api.userMessage(1), /No search option\./);
        assert.match(h.api.userMessage(1), /Web results: none\./);
        assert.ok(h.db.publishes.at(-1)?.options.every((o) => o.kind === 'reply'));
        assert.equal(h.search.calls.length, 0, 'nothing went to Apify');
        assert.equal(eventsOf(h, 'search').length, 0, 'no search event without consent');
    });

    it('still offers Search the web third in the ten minutes after a request was sent, after the call option (D24)', async () => {
        const h = startThree({ contacts: [LEON] });
        h.api.reply({
            answer_mode: 'pick',
            options: [
                reply({ label: 'Tell her', text: 'Yes, let her know.', tone: 'warm' }),
                reply({ kind: 'call', label: 'Call Leonora', text: 'Call Leonora about it.', tone: 'calm', call: { contact_id: 'leon' } }),
                reply({ label: 'No need', text: 'No need, thanks.', tone: 'firm' }),
            ],
        });
        const jobId = h.db.addOptionsJob({ questionText: 'We should let Stephen know the request was sent?', recentErrandTitle: 'Care team request', recentErrandSentAtMs: Date.now() - 60_000 });
        await waitFor(() => h.db.job(jobId)?.status === 'done');
        assert.match(h.api.userMessage(), /A web search can be offered as option 3\./);
        assert.match(h.api.userMessage(), /Contacts for a call:/, 'the call offer works as before');
        assert.deepEqual(finalPublish(h)?.options.map((o) => [o.kind, o.label]), [
            ['reply', 'Tell her'],
            ['call', 'Call Leonora'],
            ['search', 'Search the web'],
        ]);
        assert.equal(h.search.calls.length, 0);
    });

    it('refuses a search option the planner wrote when none was offered', async () => {
        const h = start(harness({ direct: true }));
        h.db.consent.webSearch = false;
        h.api.reply(withSearchReply());
        const jobId = h.db.addOptionsJob({ questionText: FUN_QUESTION });
        await waitFor(() => h.db.job(jobId)?.status === 'failed');
        assert.equal(h.db.publishes.length, 0);
        const fail = h.db.applied.find((a) => a.name === 'agentFail')?.args as { reasonCode: string } | undefined;
        assert.equal(fail?.reasonCode, 'planner_invalid_reply');
    });

    it('answers a plain yes or no question at once, "Yes" and "No", but sends one that could use outside facts to the planner', async () => {
        const h = start(harness({ direct: true, yesNoFast: true }));
        const plain = h.db.addOptionsJob({ questionText: 'Are you tired?' });
        await waitFor(() => h.db.job(plain)?.status === 'done');
        assert.deepEqual(finalPublish(h)?.options.map((o) => [o.label, o.text]), [['Yes', 'Yes.'], ['No', 'No.']]);
        assert.equal(h.api.calls.length, 0);

        h.api.reply(withSearchReply());
        const factual = h.db.addOptionsJob({ questionText: 'Is the Berkeley Public Library open on Sunday?' });
        await waitFor(() => h.db.job(factual)?.status === 'done');
        assert.equal(h.api.calls.length, 1);
        assert.ok(h.log.entries.some((e) => e.message === 'yes or no fast path not taken' && e.fields.why === 'search_possible'));
        assert.equal(h.db.publishes.at(-1)?.options[2]?.kind, 'search');
    });

    it('keeps an errand option\'s action with its short label, second, with Search the web third', async () => {
        const h = startThree({ forms: [DEMO_FORM] });
        h.api.reply({
            answer_mode: 'pick',
            options: [
                reply({
                    kind: 'errand',
                    label: 'Send request',
                    text: 'Send the care team a ride request for 1 PM.',
                    tone: 'warm',
                    errand: { form_key: 'care_team_request', fields: [{ label: 'What do you need?', value: 'Ride' }, { label: 'Details', value: 'To the aquarium at 1 PM' }] },
                }),
                reply({ label: 'Not now', text: 'Not now, thanks.', tone: 'calm' }),
            ],
        });
        const jobId = h.db.addOptionsJob({ questionText: 'Can we send the care team a request for a ride to the aquarium at 1?' });
        await waitFor(() => h.db.job(jobId)?.status === 'done');
        const published = finalPublish(h);
        // The planner put the errand first; the list is reply, errand, Search the web (D24).
        assert.deepEqual(published?.options.map((o) => [o.kind, o.label]), [
            ['reply', 'Not now'],
            ['errand', 'Send request'],
            ['search', 'Search the web'],
        ]);
        const errand = published?.options[1];
        assert.equal(JSON.parse(errand?.actionJson ?? '{}').formKey, 'care_team_request');
        assert.equal(h.search.calls.length, 0);
    });

    it('runs no search before a pick when the partner does not say "do you know"', async () => {
        const h = startThree();
        h.api.reply({ answer_mode: 'pick', options: [reply({ label: 'Giants won', text: 'I think the Giants won.', tone: 'warm' }), reply({ label: 'No idea', text: 'No idea, honestly.', tone: 'calm' })] });
        const jobId = h.db.addOptionsJob({ questionText: 'Who won the Giants game last night?' });
        await waitFor(() => h.db.job(jobId)?.status === 'done');
        assert.equal(h.search.calls.length, 0, 'the person picks Search first');
        assert.equal(h.web.indexed.size, 0);
        assert.deepEqual(eventsOf(h, 'search').map((e) => [e.status, e.detail]), [['ok', 'offered']]);
        assert.deepEqual(finalPublish(h)?.options.map((o) => o.kind), ['reply', 'reply', 'search']);
        assert.doesNotMatch(h.api.userMessage(), /already ran/);
    });
});

describe('"do you know": the options job searches at once (D24)', () => {
    const QUESTION = 'Do you know who won the Giants game last night?';

    it('runs one web search before Claude drafts, and the replies cite its rows; Search the web stays third', async () => {
        const h = startThree();
        h.search.rows = [webRow(1), webRow(2)];
        h.api.reply({
            answer_mode: 'pick',
            options: [
                reply({ label: 'Giants won', text: 'Yes, the Giants won last night.', sources: ['w1'], tone: 'warm' }),
                reply({ label: 'Not sure', text: 'Not sure, can we check?', tone: 'calm' }),
            ],
        });
        const jobId = h.db.addOptionsJob({ questionText: QUESTION });
        await waitFor(() => h.db.job(jobId)?.status === 'done');

        // The search the scan path runs: the web, with the question, once, before the planner call.
        assert.deepEqual(h.search.calls, [{ kind: 'web', query: QUESTION }]);
        assert.ok(h.trace.indexOf('search.web') < h.trace.indexOf('claude.create'), 'searched before drafting');
        assert.equal(h.api.calls.length, 1, 'no Search pick, no confirm, no categories');

        // Truthful pipeline events: started, then ok with the rows, and no "offered".
        const search = eventsOf(h, 'search');
        assert.deepEqual(search.map((e) => [e.status, e.detail]), [['started', 'web'], ['ok', 'web']]);
        assert.equal(JSON.parse(search[1]?.countsJson ?? '{}').rowCount, 2);
        assert.equal(JSON.parse(search[1]?.payloadJson ?? '{}').reason, DO_YOU_KNOW_REASON);

        // Indexed the usual way and forgotten at the end.
        const key = `q${h.db.questionOf(jobId)}`;
        assert.ok(h.web.indexed.has(key));
        assert.deepEqual(h.web.forgotten, [key]);

        const message = h.api.userMessage();
        assert.match(message, /The partner asked "do you know", so the web search already ran/);
        assert.match(message, /^w1 \(web page/m);

        const published = finalPublish(h);
        assert.equal(published?.answerMode, 'pick');
        assert.deepEqual(published?.options.map((o) => [o.kind, o.label, o.provenance, o.sources[0]?.url]), [
            ['reply', 'Giants won', 'web', 'https://example.com/page-1'],
            ['reply', 'Not sure', 'model', undefined],
            ['search', 'Search the web', 'stock', undefined],
        ]);
    });

    it('searches the maps near the venue for a place question, "d\'you know" too', async () => {
        const h = startThree({ placesNear: true });
        h.search.rows = [placeRow(1), placeRow(2)];
        h.api.reply({
            answer_mode: 'pick',
            options: [
                reply({ label: 'Pharmacy 1', text: "It's Pharmacy 1, on Main.", sources: ['w1'], tone: 'warm' }),
                reply({ label: 'Pharmacy 2', text: 'Pharmacy 2 is close too.', sources: ['w2'], tone: 'calm' }),
                reply({ kind: 'search', label: 'Search the web', text: 'Search the web for more.', tone: 'neutral' }),
            ],
        });
        const jobId = h.db.addOptionsJob({ questionText: "D'you know where the nearest pharmacy is?" });
        await waitFor(() => h.db.job(jobId)?.status === 'done');
        assert.deepEqual(h.search.calls, [{ kind: 'maps', query: 'pharmacy', near: { lat: 37.87, lng: -122.27 } }]);
        assert.deepEqual(eventsOf(h, 'search').map((e) => [e.status, e.detail]), [['started', 'maps'], ['ok', 'maps']]);
        assert.deepEqual(finalPublish(h)?.options.map((o) => [o.kind, o.label, o.provenance, o.sources[0]?.placeId]), [
            ['reply', 'Pharmacy 1', 'maps', 'place1'],
            ['reply', 'Pharmacy 2', 'maps', 'place2'],
            ['search', 'Search the web', 'model', undefined],
        ]);
    });

    it('writes the failed search truthfully and still answers, with Search the web third', async () => {
        const h = startThree();
        h.search.error = new Error('apify down');
        h.api.reply({ answer_mode: 'pick', options: [reply({ label: 'Not sure', text: 'Not sure, honestly.', tone: 'calm' }), reply({ label: 'Ask later', text: 'Ask me later.', tone: 'warm' })] });
        const jobId = h.db.addOptionsJob({ questionText: QUESTION });
        await waitFor(() => h.db.job(jobId)?.status === 'done');
        assert.deepEqual(eventsOf(h, 'search').map((e) => [e.status, e.detail]), [['started', 'web'], ['error', 'web error']]);
        const message = h.api.userMessage();
        assert.match(message, /The web search failed/);
        assert.match(message, /A web search can be offered as option 3\./);
        assert.deepEqual(finalPublish(h)?.options.map((o) => o.kind), ['reply', 'reply', 'search']);
    });
});

describe('the categories job (after a confirmed Search)', () => {
    it('offers categories for the original question with no web call and no memory, and keeps their search words', async () => {
        const h = start(harness({ direct: true }));
        h.memory.recallResult = { hits: [memoryHit(1)], instant: [], mossMs: 1, wallMs: 1 };
        h.api.reply(categoriesReply());
        const jobId = h.db.addFollowUpJob({ kind: 'categories', questionText: FUN_QUESTION, parentQuestionId: 77n });
        assert.equal(h.db.job(jobId)?.webSearchAllowed, false, 'like the module: a categories job makes no web call');
        await waitFor(() => h.db.job(jobId)?.status === 'done');
        const published = finalPublish(h);
        assert.deepEqual(published?.options.map((o) => [o.kind, o.label, o.actionJson]), [
            ['category', 'Nature', ''],
            ['category', 'Fun', ''],
            ['category', 'Thrill', ''],
            ['category', 'Something else', ''],
        ]);
        assert.equal(h.search.calls.length, 0);
        assert.equal(h.memory.recalls.length, 0, 'no memory: the search words carry nothing private');
        const message = h.api.userMessage();
        assert.match(message, /Task: offer categories\./);
        assert.match(message, /The partner asked: "Anything you want to do today in San Francisco\?"/);
        assert.match(message, /Memory items: none\./);
        assert.equal(h.deps.categoryBook?.find(77n, 'nature'), 'hiking trails in San Francisco');
        assert.equal(h.deps.categoryBook?.find(77n, 'Something fun.'), 'arcades and museums in San Francisco', 'found by its text too');
    });

    it('falls back to fixed categories when the planner fails, since the person asked to search', async () => {
        const h = start(harness({ direct: true }));
        h.api.fail(new Anthropic.BadRequestError(400, undefined, 'bad', new Headers()));
        const jobId = h.db.addFollowUpJob({ kind: 'categories', questionText: FUN_QUESTION, parentQuestionId: 78n });
        await waitFor(() => h.db.job(jobId)?.status === 'done');
        assert.deepEqual(finalPublish(h)?.options.map((o) => [o.kind, o.label, o.provenance]), [
            ['category', 'Nature', 'stock'],
            ['category', 'Fun', 'stock'],
            ['category', 'Food', 'stock'],
            ['category', 'Something else', 'stock'],
        ]);
        assert.ok(eventsOf(h, 'plan').some((e) => e.detail === 'categories stock'));
        assert.equal(h.deps.categoryBook?.find(78n, 'Nature'), 'parks and gardens in San Francisco');
    });

    it('builds fixed categories and search words from the question alone', () => {
        assert.equal(placeHint(FUN_QUESTION), 'San Francisco');
        assert.equal(placeHint('Where should we eat near Fort Mason?'), 'Fort Mason');
        assert.equal(placeHint('Who won last night?'), null);
        const facts = stockCategories('Who won the game last night?', { needsWeb: true, kind: 'facts', reason: '' }, 4);
        assert.deepEqual(facts.map((c) => [c.label, c.query]), [
            ['Quick facts', 'Who won the game last night'],
            ['Latest news', 'Who won the game last night news'],
            ['Something else', 'Who won the game last night'],
        ]);
        assert.equal(defaultCategoryQuery(FUN_QUESTION, 'Nature'), 'parks and gardens in San Francisco');
        assert.equal(defaultCategoryQuery(FUN_QUESTION, 'Something else'), 'Anything you want to do today in San Francisco');
        assert.equal(defaultCategoryQuery(FUN_QUESTION, 'Thrill'), 'Thrill in San Francisco');
        const book = new CategoryBook(1);
        book.record(1n, [{ label: 'A', text: 'a', query: 'qa' }]);
        book.record(2n, [{ label: 'B', text: 'b', query: 'qb' }]);
        assert.equal(book.find(1n, 'A'), null, 'the oldest question is let go of');
        assert.equal(book.find(2n, 'B!'), 'qb');
    });
});

describe('the category search job (after a Category pick)', () => {
    it('searches the maps near the venue with the category\'s words, indexes the rows, and offers places as replies with sources', async () => {
        const h = start(harness({ direct: true, placesNear: true }));
        h.api.reply(categoriesReply());
        const categories = h.db.addFollowUpJob({ kind: 'categories', questionText: FUN_QUESTION, parentQuestionId: 90n });
        await waitFor(() => h.db.job(categories)?.status === 'done');

        h.search.rows = [placeRow(1), placeRow(2)];
        h.api.reply({
            answer_mode: 'pick',
            options: [
                reply({ label: 'Pharmacy 1', text: "Let's go to Pharmacy 1!", sources: ['w1'], tone: 'warm' }),
                reply({ label: 'Pharmacy 2', text: 'How about Pharmacy 2?', sources: ['w2'], tone: 'calm' }),
                reply({ label: 'Something else', text: 'Something else, please.', tone: 'neutral' }),
            ],
        });
        const jobId = h.db.addFollowUpJob({ kind: 'category_search', questionText: FUN_QUESTION, parentQuestionId: 90n, category: 'Nature' });
        await waitFor(() => h.db.job(jobId)?.status === 'done');
        // Maps is centred on the venue, so the planner's words go out without their city.
        assert.deepEqual(h.search.calls, [{ kind: 'maps', query: 'hiking trails', near: { lat: 37.87, lng: -122.27 } }]);
        const key = `q${h.db.questionOf(jobId)}`;
        assert.ok(h.web.indexed.has(key), 'the rows went into the question\'s web index');
        assert.deepEqual(h.web.forgotten, [key], 'and are forgotten once it is answered');
        const published = h.db.publishes.at(-1);
        assert.equal(published?.final, true);
        assert.deepEqual(published?.options.map((o) => [o.kind, o.label, o.text, o.provenance, o.sources[0]?.placeId]), [
            ['reply', 'Pharmacy 1', "Let's go to Pharmacy 1!", 'maps', 'place1'],
            ['reply', 'Pharmacy 2', 'How about Pharmacy 2?', 'maps', 'place2'],
            ['reply', 'Something else', 'Something else, please.', 'model', undefined],
        ]);
        assert.deepEqual(eventsOf(h, 'search').map((e) => [e.status, e.detail]), [['started', 'maps'], ['ok', 'maps']]);
        const message = h.api.userMessage(1);
        assert.match(message, /Task: replies from the search\. The person picked the category "Nature"\./);
        assert.match(message, /^w1 \(place/m);
    });

    it('searches the web for a question that is not about places, with words for a category it never offered', async () => {
        const h = start(harness({ direct: true, placesNear: true }));
        h.search.rows = [webRow(1)];
        // Two options: a single answer is refused (PLAN D22).
        h.api.reply({
            answer_mode: 'pick',
            options: [
                reply({ label: 'Giants won', text: 'I heard the Giants won.', sources: ['w1'], tone: 'warm' }),
                reply({ label: 'Not sure', text: 'Not sure, can we check?', tone: 'calm' }),
            ],
        });
        const question = 'Who won the World Series game last night?';
        const jobId = h.db.addFollowUpJob({ kind: 'category_search', questionText: question, category: 'Latest news' });
        await waitFor(() => h.db.job(jobId)?.status === 'done');
        assert.deepEqual(h.search.calls, [{ kind: 'web', query: 'Latest news Who won the World Series game last night' }]);
        assert.equal(h.db.publishes.at(-1)?.options[0]?.provenance, 'web');
    });

    it('offers the places by name when the planner fails', async () => {
        const h = start(harness({ direct: true, placesNear: true }));
        h.search.rows = [placeRow(1), placeRow(2)];
        h.api.fail(new Anthropic.BadRequestError(400, undefined, 'bad', new Headers()));
        const jobId = h.db.addFollowUpJob({ kind: 'category_search', questionText: FUN_QUESTION, category: 'Nature' });
        await waitFor(() => h.db.job(jobId)?.status === 'done');
        assert.deepEqual(h.db.publishes.at(-1)?.options.map((o) => [o.kind, o.label, o.text, o.provenance, o.sources.length]), [
            ['reply', 'Pharmacy 1', "Let's go to Pharmacy 1!", 'maps', 1],
            ['reply', 'Pharmacy 2', "Let's go to Pharmacy 2!", 'maps', 1],
        ]);
        assert.ok(eventsOf(h, 'plan').some((e) => e.detail === 'places stock'));
    });

    it('fails a web result the planner cannot write, instead of reading out page titles', async () => {
        const h = start(harness({ direct: true }));
        h.search.rows = [webRow(1)];
        h.api.fail(new Anthropic.BadRequestError(400, undefined, 'bad', new Headers()));
        const jobId = h.db.addFollowUpJob({ kind: 'category_search', questionText: 'Who won the game last night?', category: 'Latest news' });
        await waitFor(() => h.db.job(jobId)?.status === 'failed');
        assert.equal(h.db.publishes.length, 0);
    });

    it('does not search without web search consent, and says why', async () => {
        const h = start(harness({ direct: true, placesNear: true }));
        const jobId = h.db.addFollowUpJob({ kind: 'category_search', questionText: FUN_QUESTION, category: 'Nature', webSearchAllowed: false });
        await waitFor(() => h.db.job(jobId)?.status === 'failed');
        assert.equal(h.search.calls.length, 0);
        const fail = h.db.applied.find((a) => a.name === 'agentFail')?.args as { reasonCode: string; reason: string } | undefined;
        assert.equal(fail?.reasonCode, 'web_search_off');
        assert.equal(fail?.reason, 'Web search is turned off, so I did not search.');
    });

    it('never puts memory into the search words', async () => {
        const h = start(harness({ direct: true, placesNear: true }));
        h.memory.recallResult = { hits: [memoryHit(1)], instant: [`${SECRET.privateMemory} 1`], mossMs: 1, wallMs: 1 };
        h.api.reply(categoriesReply());
        const categories = h.db.addFollowUpJob({ kind: 'categories', questionText: FUN_QUESTION, parentQuestionId: 91n });
        await waitFor(() => h.db.job(categories)?.status === 'done');
        h.search.rows = [placeRow(1)];
        h.api.reply({ answer_mode: 'pick', options: [reply({ label: 'Pharmacy 1', text: "Let's go to Pharmacy 1!", sources: ['w1'], tone: 'warm' })] });
        const jobId = h.db.addFollowUpJob({ kind: 'category_search', questionText: FUN_QUESTION, parentQuestionId: 91n, category: 'Fun' });
        await waitFor(() => h.db.job(jobId)?.status === 'done');
        assert.equal(h.search.calls[0]?.query, 'arcades and museums');
        for (const n of [0, 1]) assert.ok(!h.api.userMessage(n).includes('PRIVMEM'), `planner call ${n} carried no memory`);
        assert.ok(h.search.calls.every((c) => !c.query.includes('PRIVMEM')));
    });
});

describe('direct select rows and settings', () => {
    const row = {
        jobId: 7n,
        kind: { tag: 'Search' },
        status: { tag: 'Pending' },
        attempt: 0,
        claimedByMe: false,
        questionId: 12n,
        questionText: FUN_QUESTION,
        origin: { tag: 'Partner' },
        menuItem: { tag: 'None' },
        askedBy: 'ab',
        webSearchAllowed: true,
        memoryAllowed: true,
        errandId: 0n,
        formKey: '',
        formUrl: '',
        formTitle: '',
        fieldsJson: '',
        replyText: '',
        recentErrandTitle: '',
        createdAt: { microsSinceUnixEpoch: 1_700_000_000_000_000n },
        parentQuestionId: 10n,
        parentQuestionText: FUN_QUESTION,
        category: 'Nature',
    };

    it('reads the module\'s Categories and Search jobs, with the original question and the category', () => {
        const search = toAgentQueueRow(row);
        assert.equal(search.kind, 'category_search');
        assert.equal(search.parentQuestionId, 10n);
        assert.equal(search.parentQuestionText, FUN_QUESTION);
        assert.equal(search.category, 'Nature');
        assert.equal(toAgentQueueRow({ ...row, kind: { tag: 'Categories' }, category: '' }).kind, 'categories');
        assert.throws(() => toAgentQueueRow({ ...row, kind: { tag: 'Mystery' } }), (e: unknown) => e instanceof ContractError && /unknown job kind mystery/.test(e.message));
        const { parentQuestionText: _gone, ...old } = row;
        assert.throws(() => toAgentQueueRow(old), (e: unknown) => e instanceof ContractError);
    });

    it('runs direct select by default, keeps the scan path on AGENT_INPUT_MODE=scan, and refuses anything else', () => {
        const token = join(tmpdir(), 'say-when-direct-test-token');
        assert.equal(readConfig({}, token, () => true).config.inputMode, 'direct');
        assert.equal(readConfig({ AGENT_INPUT_MODE: 'scan' }, token, () => true).config.inputMode, 'scan');
        const bad = readConfig({ AGENT_INPUT_MODE: 'scanning' }, token, () => true);
        assert.ok(bad.problems.includes('AGENT_INPUT_MODE must be direct or scan.'));
        assert.ok(bad.checks.some((c) => c.name === 'AGENT_INPUT_MODE' && c.state === 'invalid'));
    });
});
