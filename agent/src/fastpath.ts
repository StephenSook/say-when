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
    | 'list'
    | 'wh_word'
    | 'knowledge'
    | 'open_ended'
    | 'errand_verb'
    | 'compound'
    | 'request'
    | 'main_verb'
    | 'long'
    | 'vocabulary'
    | 'second_verb'
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
 * A list of alternatives: "mild/moderate/severe", "tea, coffee, juice", "tea & toast". Any comma, slash or ampersand
 * counts (also a comma that only names someone, "Are you okay, Sam?"): the planner can still answer yes or no.
 */
const LIST = /[,/&\-\u2010-\u2015]/;
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
 * The only requests that stay fast: "would you like ..." (an offer, checked by the offer rules) and the check-ins
 * "can/could you hear me" and "can/could you see me". Every other "can/could/would/will you ..." asks the person to
 * do something ("Could you feel the water for me?") and goes to the planner (review round 10).
 */
const REQUEST_FAST = /^(?:would you like\b|(?:can|could) you (?:hear|see) me[?]*$)/;
/** A favor: "... for me?", "... for us?". */
const FAVOR = /\bfor (?:me|us)\b/;
/**
 * The plain verbs of hearing, seeing, feeling, wanting and understanding: the base of the offer and main-verb lists.
 */
const REQUEST_SAFE: readonly string[] = ['hear', 'see', 'feel', 'like', 'want', 'need', 'understand'];
/**
 * An offer to act: "do you want (me) to ...", "would you like (me) to ...", "should I ...", "shall I ...", "can I ...",
 * and "able, willing, ready, going or trying to ..." ("Are you able to describe it?").
 * Yes or no only when the verb is on OFFER_SAFE ("Do you want to go outside?", "Shall we go?", "May I sit here?").
 */
const OFFER_WANT = /\b(?:want|wants|like|need|needs|able|willing|ready|going|trying)(?: (?:me|us|him|her|them|someone|somebody))? to ([a-z]+)/;
const OFFER_SELF = /^(?:should|shall|can|could|may|will) (?:i|we) ([a-z]+)/;
// No verb that acts on a thing or a person ("move my chair", "read this", "watch the baby", "come with us"): those are
// requests for the planner, even when the answer could be yes or no (review round 8).
const OFFER_SAFE: readonly string[] = [...REQUEST_SAFE, 'go', 'sit', 'rest', 'stay', 'wait', 'stand', 'lie'];
/** A wh-question, also an embedded one ("Do you know where it is?", "Do you know if it is open?"). */
const WH_WORD = /\b(what|whats|when|where|which|who|whom|whose|why|how|whether|if)\b/;
/** A question about what the person knows ("Do you know the doctor's name?"): it asks for the content, not a yes. */
const KNOWLEDGE = /\b(know|knows|knew|remember|remembers|remembered|recall|recalls|recalled)\b/;
/** A need left open ("Do you need anything?", "Is there ..."): the planner can offer what it could be, errands included. */
const OPEN_ENDED = /\b(anything|something|someone|somebody|anyone|anybody)\b|^(is|are|was|were) there\b/;
/** A sentence break followed by more words: two questions, or a question and a statement. */
const SENTENCE_BREAK = /[.?!;]\s+\S/;
/** Two things asked at once ("Can you hear me and say your name?"): a safe first part must not approve the rest. */
const COMPOUND = /\b(and|but|then|also|plus)\b/;
/** Asks for words or a showing, not a yes ("Do you mind describing your pain?", "Are you saying no?"). */
const CONTENT_VERB = /\b(mind|minds|describe|describes|describing|explain|explains|explaining|say|says|saying|said|spell|spelling|show|shows|showing|repeat|repeating|share|sharing|point|pointing|choose)\b/;
/** The auxiliaries followed by a subject and a bare verb ("Do you want", "Will it rain", "May I sit"). */
const DO_OR_MODAL: readonly string[] = ['do', 'does', 'did', 'can', 'could', 'will', 'would', 'should', 'shall', 'may', 'might'];
/**
 * After one of DO_OR_MODAL, the subject must be a pronoun and the main verb one of these plain yes or no verbs.
 * Anything else ("Did you finish the soup?", "Does your back hurt?", "Do you prefer the window seat?") goes to the
 * planner, which can still answer yes or no.
 */
// Wider than the request and offer lists: "Did you sleep well?" and "Did you eat lunch?" ask about the person, while
// "Could you breathe in?" and "Can you eat the soup?" are caught as requests before this list is read.
const MAIN_SAFE: readonly string[] = [...OFFER_SAFE, 'be', 'hurt', 'ache', 'agree', 'enjoy', 'love', 'care', 'understand', 'sleep', 'breathe', 'eat', 'drink', 'swallow'];
const PRONOUN_VERB = /^[a-z]+ (?:you|i|we|it|he|she|they) ([a-z]+)/;
/** After have, has and had: a pronoun subject and one of these plain participles ("Have you eaten yet?"). */
const HAVE: readonly string[] = ['have', 'has', 'had'];
/** Every "to" with a verb after it is checked, not only the first ("Do you care to elaborate?", "going to the store"). */
const TO_VERB = /\bto ([a-z]+)/g;
/** At most this many words in a fast question; longer ones go to the planner. */
const MAX_WORDS = 9;
/** At most this many words after the main verb, none a particle that changes the verb ("come up with"). */
const MAX_TAIL_WORDS = 4;
const PARTICLES: readonly string[] = ['up', 'out', 'off', 'over', 'down', 'back', 'about', 'around', 'through', 'into', 'onto', 'away', 'together', 'along'];
/** After is, are, was or were and a pronoun, a verb in -ing must be one of these ("Are you feeling okay?"). */
const BE: readonly string[] = ['is', 'are', 'was', 'were'];
const GERUND_SAFE: readonly string[] = ['feeling', 'coming', 'going', 'sleeping', 'listening', 'eating', 'resting', 'waiting', 'watching', 'hurting', 'breathing', 'sitting', 'staying'];
const PARTICIPLE_SAFE: readonly string[] = ['eaten', 'slept', 'heard', 'seen', 'felt', 'been', 'had', 'rested', 'drunk', 'tried', 'enjoyed', 'liked', 'understood', 'come', 'gone', 'walked', 'met'];

/**
 * The closed list of words a fast question may use, and nothing else: the auxiliaries, pronouns and small function
 * words, the plain verbs above, and words for how the person feels and what is around them. Any other word sends the
 * question to the planner ("Can you come help me?"), which can still answer yes or no. After is, are, was and were a
 * name is allowed too (a capitalized word that is not the first: "Is Sam here?", "Is the Berkeley Public Library
 * open on Sunday?").
 */
const FUNCTION_WORDS = [
    'i', 'you', 'we', 'it', 'he', 'she', 'they', 'me', 'us', 'him', 'her', 'them', 'my', 'your', 'our', 'his', 'its', 'their',
    'this', 'that', 'these', 'those', 'the', 'a', 'an', 'some', 'any', 'more', 'less', 'much', 'too', 'very', 'so', 'still',
    'yet', 'now', 'today', 'tonight', 'tomorrow', 'later', 'soon', 'again', 'already', 'here', 'there', 'outside', 'inside',
    'home', 'well', 'really', 'enough', 'all', 'not', 'to', 'on', 'in', 'at', 'with', 'for', 'of', 'from', 'by', 'near',
    'before', 'last', 'morning', 'afternoon', 'evening', 'night', 'minute', 'minutes', 'hour', 'week', 'day', 'right',
];
const STATE_WORDS = [
    'tired', 'hungry', 'thirsty', 'cold', 'hot', 'warm', 'cool', 'okay', 'ok', 'alright', 'comfortable', 'uncomfortable',
    'ready', 'sure', 'done', 'open', 'closed', 'happy', 'sad', 'sick', 'awake', 'asleep', 'fine', 'good', 'bad', 'better',
    'worse', 'full', 'wet', 'dry', 'scared', 'afraid', 'bored', 'finished', 'busy', 'free', 'sleepy', 'nervous', 'worried',
    'excited', 'safe', 'quiet', 'loud', 'bright', 'dark', 'fun', 'nice', 'late', 'early', 'able', 'in', 'pain',
];
const THING_WORDS = [
    'water', 'tea', 'coffee', 'juice', 'milk', 'food', 'lunch', 'dinner', 'breakfast', 'snack', 'soup', 'music', 'tv',
    'light', 'lights', 'window', 'blanket', 'pillow', 'chair', 'bed', 'room', 'medicine', 'pills', 'nap', 'break', 'bath',
    'shower', 'head', 'arm', 'leg', 'legs', 'foot', 'feet', 'stomach', 'chest', 'eyes', 'glasses', 'screen', 'pharmacy',
    'store', 'library', 'cafe', 'park', 'clinic', 'hospital', 'office', 'door', 'car', 'bus', 'shop', 'market',
];
const VOCABULARY: ReadonlySet<string> = new Set([
    ...AUXILIARIES,
    ...FUNCTION_WORDS,
    ...STATE_WORDS,
    ...THING_WORDS,
    ...MAIN_SAFE,
    ...GERUND_SAFE,
    ...PARTICIPLE_SAFE,
]);
/** The plain verbs: after the main verb one may follow only right after "to" ("want to go", never "come read"). */
const VERBS: ReadonlySet<string> = new Set(MAIN_SAFE);
const NAME = /^[A-Z][a-z]*(?:'s)?$/;

/**
 * True only for a question that begins with an auxiliary verb, offers no choice ("or", "between", "pick") and no list,
 * has no wh-word, asks nothing about what the person knows, leaves no need open, names no errand or call verb ("call",
 * "send", "submit", "get"), asks one thing, asks for no words ("describe", "say"), is not a request or an offer to act
 * ("could you hand me", "do you want me to open", "shall I turn on") unless its verb is a plain yes or no one, is one
 * sentence, does not end like a statement ("." or "!"), and, after do, can, will and the other modals (or have, has
 * and had), has a pronoun subject and a plain yes or no main verb (or participle); or for any question carrying the
 * smoke tag.
 */
export function classifyYesNo(question: string): YesNoVerdict {
    const cased = question
        .replace(/[‘’ʼ]/g, "'")
        .replace(/\s+/g, ' ')
        .trim();
    const text = cased.toLowerCase();
    if (text === '') return { yesNo: false, reason: 'empty' };
    if (text.includes(SMOKE_TAG)) return { yesNo: true, reason: 'smoke_tag' };
    // Opening quotes or punctuation do not count as the first word.
    const body = text.replace(/^[^a-z]+/, '');
    const first = /^[a-z]+(?:'[a-z]+)?/.exec(body)?.[0] ?? '';
    if (!AUXILIARIES.includes(first)) return { yesNo: false, reason: 'no_auxiliary' };
    if (CHOICE.test(body)) return { yesNo: false, reason: 'choice' };
    if (LIST.test(body)) return { yesNo: false, reason: 'list' };
    if (WH_WORD.test(body)) return { yesNo: false, reason: 'wh_word' };
    if (KNOWLEDGE.test(body)) return { yesNo: false, reason: 'knowledge' };
    if (OPEN_ENDED.test(body)) return { yesNo: false, reason: 'open_ended' };
    if (ERRAND_VERB.test(body)) return { yesNo: false, reason: 'errand_verb' };
    if (COMPOUND.test(body)) return { yesNo: false, reason: 'compound' };
    if (CONTENT_VERB.test(body)) return { yesNo: false, reason: 'request' };
    if (FAVOR.test(body)) return { yesNo: false, reason: 'request' };
    if (REQUEST_START.test(body) && !REQUEST_FAST.test(body.replace(/["'“”)\s]+$/, ''))) return { yesNo: false, reason: 'request' };
    for (const offer of [OFFER_WANT, OFFER_SELF]) {
        const verb = offer.exec(body)?.[1];
        if (verb !== undefined && !OFFER_SAFE.includes(verb)) return { yesNo: false, reason: 'request' };
    }
    for (const match of body.matchAll(TO_VERB)) {
        if (!OFFER_SAFE.includes(match[1] ?? '')) return { yesNo: false, reason: 'request' };
    }
    const end = body.replace(/["'“”)\s]+$/, '');
    if (end.endsWith('.') || end.endsWith('!')) return { yesNo: false, reason: 'statement' };
    if (SENTENCE_BREAK.test(end)) return { yesNo: false, reason: 'several_sentences' };
    const words = end.replace(/[?]+$/, '').split(' ').filter((word) => word !== '');
    if (words.length > MAX_WORDS) return { yesNo: false, reason: 'long' };
    if (DO_OR_MODAL.includes(first) || HAVE.includes(first)) {
        // [auxiliary, pronoun, verb, ...tail]: the main verb's company is checked too.
        const tail = words.slice(3);
        if (tail.length > MAX_TAIL_WORDS || tail.some((word) => PARTICLES.includes(word))) return { yesNo: false, reason: 'main_verb' };
    }
    if (BE.includes(first)) {
        const word = PRONOUN_VERB.exec(body)?.[1];
        if (word !== undefined && word.endsWith('ing') && !GERUND_SAFE.includes(word)) return { yesNo: false, reason: 'main_verb' };
    }
    if (DO_OR_MODAL.includes(first)) {
        const verb = PRONOUN_VERB.exec(body)?.[1];
        if (verb === undefined || !MAIN_SAFE.includes(verb)) return { yesNo: false, reason: 'main_verb' };
    }
    if (HAVE.includes(first)) {
        const participle = PRONOUN_VERB.exec(body)?.[1];
        if (participle === undefined || !PARTICIPLE_SAFE.includes(participle)) return { yesNo: false, reason: 'main_verb' };
    }
    // The same words with their case, for names. Lowercasing keeps every length, so the positions match.
    const casedWords = cased
        .slice(text.length - body.length)
        .slice(0, end.length)
        .replace(/[?]+$/, '')
        .split(' ')
        .filter((word) => word !== '');
    const mainVerbAt = DO_OR_MODAL.includes(first) || HAVE.includes(first) ? 2 : -1;
    for (let i = 0; i < words.length; i++) {
        const word = words[i] ?? '';
        if (!VOCABULARY.has(word)) {
            // Names only when the cased text lines up with the lowercased one (some letters change length).
            const isName = BE.includes(first) && i > 0 && cased.length === text.length && NAME.test(casedWords[i] ?? '');
            if (!isName) return { yesNo: false, reason: 'vocabulary' };
            continue;
        }
        if (VERBS.has(word) && i !== mainVerbAt && words[i - 1] !== 'to') return { yesNo: false, reason: 'second_verb' };
    }
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
