/** Stages this package reports, a subset of `pipeline_event.stage` in PLAN.md. */
export type PipelineStage = 'listen' | 'speak' | 'call';
export type PipelineStatus = 'started' | 'ok' | 'error';

/**
 * One content-free step report: the shape of `pipeline_event` in PLAN.md minus its id, session and time.
 * Never carries transcript text, names, phone numbers, keys or tokens.
 */
export interface PipelineEvent {
    stage: PipelineStage;
    status: PipelineStatus;
    /** A short fixed phrase, for example "socket open" or "refused: do_not_call". */
    detail: string;
    /** Milliseconds the step took; 0 when it starts. */
    ms: number;
    counts?: Record<string, number>;
}

export type OnEvent = (event: PipelineEvent) => void;

const API_KEY = /sk_car_[A-Za-z0-9_-]+/g;
const TOKEN_PARAM = /(access_token|api_key)=[^&\s"']+/gi;
// Starts only where a run of token characters starts, so a long run is scanned once, not once per character.
const JWT_LIKE = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;

// Characters nobody sees: zero-width spaces and joiners, direction marks, soft hyphens, variation selectors and
// Hangul fillers. They are dropped, so they cannot hide a key or split a number word.
const INVISIBLE = /\p{Default_Ignorable_Code_Point}/gu;
// Every number character: digits in any script, and the circled, superscript and fraction forms NFKC leaves behind.
const NUMBER = /\p{N}/gu;
// A word: a letter, then letters and their combining marks.
const WORD = /\p{L}[\p{L}\p{M}]*/gu;
// Spoken number words, as speech to text may write a phone number out: zero to nineteen, the tens, hundred,
// thousand, and "oh", "o", "nought", "double" and "triple" as people say them in a number.
const NUMBER_WORDS = [
    'zero', 'oh', 'o', 'nought', 'naught', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
    'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen',
    'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety', 'hundred', 'thousand', 'double', 'triple',
];
// A word made only of number words, so "fourone" (two words joined once an invisible character between them is
// dropped) is masked too. Longest first; the speed test checks long words that almost match.
const NUMBER_WORD = new RegExp(`^(?:${[...NUMBER_WORDS].sort((a, b) => b.length - a.length).join('|')})+$`);

/** A word's lower-case letters without accents, so "four" with an accent on the o is still "four". */
function plainWord(word: string): string {
    return word.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/**
 * The public copy of any text: dashboard transcript lines, call summaries, event details and error messages. The text
 * is NFKC-normalized and stripped of invisible characters; keys and tokens become [key] and [token]; then every
 * number character becomes # and every spoken number word ("four", "fifteen", "oh", "double") becomes #. There is no
 * exception for dates, times or prices: they are masked too, on purpose, because a phone number can take any of
 * those shapes. The result is the normalized, masked text; the private original is never changed.
 */
export function redact(text: string): string {
    return String(text)
        .normalize('NFKC')
        .replace(INVISIBLE, '')
        .replace(API_KEY, '[key]')
        .replace(TOKEN_PARAM, '$1=[token]')
        .replace(JWT_LIKE, '[token]')
        .replace(NUMBER, '#')
        .replace(WORD, (word) => (NUMBER_WORD.test(plainWord(word)) ? '#' : word));
}

const COUNT_NAME = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;

/** Sends a cleaned copy of the event. A sink that throws is ignored: telemetry must never stop speech or a cancel. */
export function emit(onEvent: OnEvent | undefined, event: PipelineEvent): void {
    if (!onEvent) return;
    const clean: PipelineEvent = {
        stage: event.stage,
        status: event.status,
        detail: redact(event.detail).slice(0, 120),
        ms: Number.isFinite(event.ms) ? Math.max(0, Math.round(event.ms)) : 0,
    };
    if (event.counts) {
        const counts: Record<string, number> = {};
        for (const [name, value] of Object.entries(event.counts)) {
            if (COUNT_NAME.test(name) && Number.isFinite(value)) counts[name] = value;
        }
        if (Object.keys(counts).length > 0) clean.counts = counts;
    }
    try {
        onEvent(clean);
    } catch {
        // Deliberately ignored, see above.
    }
}
