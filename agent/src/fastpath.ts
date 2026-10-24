// The yes or no fast path (AGENT_YES_NO_FAST). A question that is clearly yes or no gets two stock options at
// once, without memory, search or Claude, so the person hears "Yes or no?" within a reducer round trip of the
// question instead of after a search and a plan (session 15 on say-when-dev: 9.9 s, 6.6 s of it a web search).
//
// In yes_no mode the person never hears the option texts: the station plays the stock prompt "Yes or no?", YES picks
// rank 1 and NO rank 2 (docs/spacetime.md 4.1), and the picked text is said aloud. So the stock texts are exactly
// what the person chose, with nothing added that they did not hear.
//
// The classifier is deterministic and conservative. Anything it is unsure of goes the normal way.

import type { OptionInput } from './types.js';

/** Why a question did or did not take the fast path. Fixed codes, safe to log: they never quote the question. */
export type YesNoReason =
    | 'smoke_tag'
    | 'auxiliary'
    | 'empty'
    | 'no_auxiliary'
    | 'choice'
    | 'wh_word'
    | 'errand_verb'
    | 'request'
    | 'statement'
    | 'several_sentences';

export interface YesNoVerdict {
    yesNo: boolean;
    reason: YesNoReason;
}

/** The auxiliary verbs a yes or no question may begin with. Contractions ("don't", "isn't") are not on the list. */
export const AUXILIARIES: readonly string[] = [
    'do', 'does', 'did', 'is', 'are', 'was', 'were', 'can', 'could', 'will', 'would', 'should', 'shall', 'have', 'has', 'had', 'may', 'might',
];

/** The smoke tests' marker for a yes or no question (spacetime/scripts/watch-scan.ts, docs/station.md 7.5). */
const SMOKE_TAG = '[yes_no]';
/** A choice between things: "tea or coffee", "pick between them", "would you rather". */
const CHOICE = /\b(or|either|versus|vs|between|rather|choose|chooses|chose|chosen|choosing|pick|picks|picked|picking)\b/;
/**
 * Anything the planner could turn into an errand or a call option ("Can you send the care team a request?", "Do you
 * want to submit a care team request?", "Should I get the nurse?"). A stock Yes would only say "Yes." and do nothing,
 * so these always go to the planner.
 */
const ERRAND_VERB =
    /\b(call|calls|called|calling|phone|phones|phoned|phoning|text|texts|texted|texting|message|messages|messaged|messaging|email|emails|emailed|emailing|send|sends|sent|sending|book|books|booked|booking|order|orders|ordered|ordering|remind|reminds|reminded|reminding|reminder|schedule|schedules|scheduled|scheduling|buy|buys|bought|buying|fill|fills|filled|filling|submit|submits|submitted|submitting|request|requests|requested|requesting|ask|asks|asked|asking|tell|tells|told|telling|get|gets|got|gotten|getting|bring|brings|brought|bringing|fetch|fetches|fetched|fetching|contact|contacts|contacted|contacting|notify|notifies|notified|notifying|reserve|reserves|reserved|reserving|pay|pays|paid|paying|deliver|delivers|delivered|delivering)\b/;
/** "Can you", "could you", "would you", "will you": the start of a request unless the verb is on REQUEST_SAFE. */
const REQUEST_START = /^(can|could|would|will) you\b/;
/**
 * The only verbs after "can/could/would/will you" that keep a question yes or no: what the person hears, feels,
 * wants or is able to do. Anything else ("would you mind", "could you hand me", "can you please") reads as a request.
 */
const REQUEST_SAFE: readonly string[] = ['hear', 'see', 'feel', 'like', 'want', 'need', 'remember', 'understand', 'sleep', 'breathe', 'eat', 'drink', 'swallow', 'taste', 'smell', 'move', 'come', 'be'];
/**
 * An offer to act: "do you want (me) to ...", "would you like (me) to ...", "should I ...", "shall I ...", "can I ...".
 * Yes or no only when the verb is on OFFER_SAFE ("Do you want to go outside?", "Shall we go?", "May I sit here?").
 */
const OFFER_WANT = /\b(?:want|wants|like|need|needs)(?: (?:me|us|him|her|them|someone|somebody))? to ([a-z]+)/;
const OFFER_SELF = /^(?:should|shall|can|could|may|will) (?:i|we) ([a-z]+)/;
const OFFER_SAFE: readonly string[] = [...REQUEST_SAFE, 'go', 'sit', 'rest', 'stay', 'wait', 'talk', 'listen', 'watch', 'read', 'walk', 'stand', 'lie', 'try', 'play'];
/** A wh-question, also an embedded one ("Do you know where it is?"). */
const WH_WORD = /\b(what|whats|when|where|which|who|whom|whose|why|how|whether)\b/;
/** A sentence break followed by more words: two questions, or a question and a statement. */
const SENTENCE_BREAK = /[.?!;]\s+\S/;

/**
 * True only for a question that begins with an auxiliary verb, offers no choice ("or", "between", "pick"), has no
 * wh-word, names no errand or call verb ("call", "send", "submit", "get"), is not a request or an offer to act ("could
 * you hand me", "do you want me to open", "shall I turn on") unless its verb is a plain yes or no one, is one
 * sentence and does not end like a statement ("." or "!"); or for any question carrying the smoke tag.
 */
export function classifyYesNo(question: string): YesNoVerdict {
    const text = question
        .replace(/[‘’ʼ]/g, "'")
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
    if (text === '') return { yesNo: false, reason: 'empty' };
    if (text.includes(SMOKE_TAG)) return { yesNo: true, reason: 'smoke_tag' };
    // Opening quotes or punctuation do not count as the first word.
    const body = text.replace(/^[^a-z]+/, '');
    const first = /^[a-z]+(?:'[a-z]+)?/.exec(body)?.[0] ?? '';
    if (!AUXILIARIES.includes(first)) return { yesNo: false, reason: 'no_auxiliary' };
    if (CHOICE.test(body)) return { yesNo: false, reason: 'choice' };
    if (WH_WORD.test(body)) return { yesNo: false, reason: 'wh_word' };
    if (ERRAND_VERB.test(body)) return { yesNo: false, reason: 'errand_verb' };
    if (REQUEST_START.test(body)) {
        const verb = /^[a-z]+ you ([a-z]+)/.exec(body)?.[1] ?? '';
        if (!REQUEST_SAFE.includes(verb)) return { yesNo: false, reason: 'request' };
    }
    for (const offer of [OFFER_WANT, OFFER_SELF]) {
        const verb = offer.exec(body)?.[1];
        if (verb !== undefined && !OFFER_SAFE.includes(verb)) return { yesNo: false, reason: 'request' };
    }
    const end = body.replace(/["'“”)\s]+$/, '');
    if (end.endsWith('.') || end.endsWith('!')) return { yesNo: false, reason: 'statement' };
    if (SENTENCE_BREAK.test(end)) return { yesNo: false, reason: 'several_sentences' };
    return { yesNo: true, reason: 'auxiliary' };
}

/** Provenance of a stock option: not Claude, not memory, not the web. */
export const STOCK_PROVENANCE = 'stock' as const;

/**
 * The stock yes or no options: rank 1 is yes and rank 2 is no (the module's yes_no rule), both replies, with the
 * distinct tones the planner's own yes or no options must have.
 */
export function stockYesNo(): OptionInput[] {
    const option = (text: string, tone: OptionInput['tone']): OptionInput => ({
        kind: 'reply',
        text,
        tone,
        laugh: false,
        provenance: STOCK_PROVENANCE,
        sources: [],
        memoryRefs: [],
        actionJson: '',
    });
    return [option('Yes.', 'neutral'), option('No.', 'calm')];
}
