// Fixes the shape of a planner reply before validate.ts checks it (PLAN D27), so a reply with one rule broken in a
// way the code can mend still reaches the person instead of failing the job. Deterministic and with no model call. It
// only removes, cuts or re-labels what the model wrote; it never writes a new option or a new fact:
// - a search option where none is offered, a second one, or one with sources or an action, is dropped (when a search
//   is offered, the direct select code adds its own stock Search option third, src/direct.ts withSearch);
// - a yes or no reply carrying an errand or a call becomes a pick (the prompt asks for a pick then);
// - a text over the limit is cut at a sentence or word boundary, a label over the limit at a word boundary;
// - an option whose text repeats an earlier one is dropped; a source id that was never given is dropped (the option stays);
// - too many options: a model-written search goes first (the code adds it back), then the last replies, keeping the
//   errand and the call options and the planner's order;
// - a tone used twice gets the next unused tone, and only the first laugh is kept.
// What it fixed is named in `fixes` (rule names only, never the reply's words), for the log.

import { LABEL_LIMITS, LIMITS } from '../contract.js';
import { TONES, type Tone } from '../types.js';
import type { PlanReply } from './schema.js';
import type { PlanInput } from './types.js';
import { MIN_PICK_OPTIONS, TEXT_MAX_WORDS } from './validate.js';

type ReplyOption = PlanReply['options'][number];

export interface Repaired {
    reply: PlanReply;
    /** The fixes made, by name, sorted. Empty when the reply is unchanged. */
    fixes: string[];
    /**
     * True when the fixes left a pick answer with fewer than two options although the model wrote at least two. The
     * sidecar fills it back up with stock replies (buildOptions, withSearch, PLAN D22), so validation accepts one.
     */
    short: boolean;
}

const clean = (text: string): string => text.replace(/\s+/g, ' ').trim();
const key = (text: string): string => clean(text).toLowerCase();
const wordsOf = (text: string): string[] => (clean(text) === '' ? [] : clean(text).split(' '));
const isAction = (option: ReplyOption): boolean => option.kind === 'errand' || option.kind === 'call';
/** Trailing commas, colons, semicolons and dashes (en and em dash included), left by a cut. */
const TRAILING = /[\s,;:\u2013\u2014-]+$/u;

/** The first `maxWords` words, within `maxChars`, or null when not even one word fits. */
function cutWords(text: string, maxWords: number, maxChars: number): string | null {
    const kept = wordsOf(text).slice(0, maxWords);
    while (kept.length > 0 && kept.join(' ').length > maxChars) kept.pop();
    return kept.length > 0 ? kept.join(' ') : null;
}

/** A spoken text cut to the limits: at the last sentence end that fits, else at a word boundary. Null if it cannot be. */
function cutText(text: string): string | null {
    const cut = cutWords(text, TEXT_MAX_WORDS, LIMITS.optionText);
    if (cut === null) return null;
    // A whole sentence when it keeps at least half the words; else the words that fit, ending the sentence there.
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    if (end > 0 && wordsOf(cut.slice(0, end + 1)).length * 2 >= wordsOf(cut).length) return cut.slice(0, end + 1);
    return `${cut.replace(TRAILING, '')}.`.replace(/([.!?])\.$/, '$1');
}

/** The next tone after `tone` that no option uses yet. */
function nextTone(tone: Tone, used: Set<Tone>): Tone | null {
    const start = TONES.indexOf(tone);
    for (let i = 1; i <= TONES.length; i++) {
        const candidate = TONES[(start + i) % TONES.length] as Tone;
        if (!used.has(candidate)) return candidate;
    }
    return null;
}

export function repairReply(reply: PlanReply, input: PlanInput): Repaired {
    const task = input.task ?? 'options';
    const max = Math.min(Math.max(1, input.maxOptions), LIMITS.maxOptions);
    const fixes = new Set<string>();
    let mode = reply.answer_mode;
    let options: ReplyOption[] = reply.options.map((o) => ({ ...o, sources: [...o.sources] }));

    // Search options. Offered only in the options task, in pick mode; the code then adds its own if this one goes.
    const searchOffered = task === 'options' && input.searchOffer === true && mode === 'pick';
    let searchSeen = false;
    options = options.filter((o) => {
        if (o.kind !== 'search') return true;
        if (!searchOffered) fixes.add('drop_search');
        else if (searchSeen) fixes.add('drop_extra_search');
        else if (o.sources.length > 0 || o.errand !== null || o.call !== null) fixes.add('drop_bad_search');
        else {
            searchSeen = true;
            return true;
        }
        return false;
    });

    // An errand or a call is never offered in yes_no mode; the prompt asks for a pick when one fits.
    if (mode === 'yes_no' && task === 'options' && options.some(isAction)) {
        mode = 'pick';
        fixes.add('mode_pick');
    }

    // Texts: cut to one short sentence, then drop an option that repeats an earlier text.
    const texts = new Set<string>();
    options = options.filter((o) => {
        if (clean(o.text).length > LIMITS.optionText || wordsOf(o.text).length > TEXT_MAX_WORDS) {
            const cut = cutText(o.text);
            if (cut !== null) {
                o.text = cut;
                fixes.add('trim_text');
            }
        }
        const k = key(o.text);
        if (k !== '' && texts.has(k)) {
            fixes.add('drop_duplicate_text');
            return false;
        }
        texts.add(k);
        return true;
    });

    // Sources the planner was never shown are dropped; the option stays.
    const refs = new Set<string>([...input.memory.map((m) => m.ref), ...input.web.map((w) => w.ref)]);
    for (const o of options) {
        const known = o.sources.filter((ref) => refs.has(ref));
        if (known.length !== o.sources.length) {
            o.sources = known;
            fixes.add('drop_unknown_source');
        }
    }

    // Too many options. A model-written search goes first, since the code adds the Search option back.
    if (options.length > max && options.some((o) => o.kind === 'search')) {
        options = options.filter((o) => o.kind !== 'search');
        fixes.add('drop_search_over_limit');
    }
    if (options.length > max) {
        const keep = new Set<ReplyOption>();
        const hasOther = options.some((o) => !isAction(o));
        // The errand and call options first, leaving room for at least one reply; then the rest in the planner's order.
        for (const o of options) if (isAction(o) && keep.size < (hasOther ? max - 1 : max)) keep.add(o);
        for (const o of options) if (!isAction(o) && keep.size < max) keep.add(o);
        options = options.filter((o) => keep.has(o));
        fixes.add('drop_over_limit');
    }

    // Labels over the limit are cut at a word boundary (a place name may run to five words).
    const places = new Set<string>(input.web.filter((w) => w.kind === 'maps').map((w) => w.ref));
    for (const o of options) {
        const limit = o.sources.some((ref) => places.has(ref)) ? LABEL_LIMITS.placeWords : LABEL_LIMITS.words;
        if (wordsOf(o.label).length > limit || clean(o.label).length > LABEL_LIMITS.chars) {
            const cut = cutWords(o.label, limit, LABEL_LIMITS.chars);
            if (cut !== null) {
                o.label = cut.replace(TRAILING, '') || cut;
                fixes.add('trim_label');
            }
        }
    }

    // A category is never said aloud, so its tone and laugh do not matter.
    if (task !== 'categories') {
        const used = new Set<Tone>();
        for (const o of options) {
            if (used.has(o.tone)) {
                const tone = nextTone(o.tone, used);
                if (tone !== null) {
                    o.tone = tone;
                    fixes.add('retone');
                }
            }
            used.add(o.tone);
        }
        let laughed = false;
        for (const o of options) {
            if (!o.laugh) continue;
            if (laughed) {
                o.laugh = false;
                fixes.add('drop_extra_laugh');
            }
            laughed = true;
        }
    }

    const short = mode === 'pick' && task === 'options' && reply.options.length >= MIN_PICK_OPTIONS && options.length < MIN_PICK_OPTIONS;
    return { reply: { answer_mode: mode, options }, fixes: [...fixes].sort(), short };
}
