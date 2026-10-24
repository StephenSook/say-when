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
export type YesNoReason = 'smoke_tag' | 'auxiliary' | 'empty' | 'no_auxiliary' | 'or_choice' | 'wh_word' | 'statement' | 'several_sentences';

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
/** A choice between things: "tea or coffee". */
const CHOICE = /\b(or|either|versus|vs)\b/;
/** A wh-question, also an embedded one ("Do you know where it is?"). */
const WH_WORD = /\b(what|whats|when|where|which|who|whom|whose|why|how|whether)\b/;
/** A sentence break followed by more words: two questions, or a question and a statement. */
const SENTENCE_BREAK = /[.?!;]\s+\S/;

/**
 * True only for a question that begins with an auxiliary verb, offers no "or" choice, has no wh-word, is one
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
    if (CHOICE.test(body)) return { yesNo: false, reason: 'or_choice' };
    if (WH_WORD.test(body)) return { yesNo: false, reason: 'wh_word' };
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
