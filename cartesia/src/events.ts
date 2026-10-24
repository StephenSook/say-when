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

// Numbers are found on a shadow of the text: d for a written digit in any script (full-width too), w for each digit a
// spoken number word stands for ("fifteen" stands for two), + for a plus sign, / for a slash, o for an opening
// bracket, c for a comma or semicolon, x for any other word or a colon, and s for everything else that can sit
// between digits: spaces, dashes, dots, bullets, closing brackets, combining marks and invisible characters, in any of
// their Unicode forms. The patterns on it repeat only over classes that exclude digits, so matching stays linear.
const NUMBER_WORDS = new Map<string, number>([
    ...['zero', 'oh', 'o', 'nought', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'double'].map((w): [string, number] => [w, 1]),
    ...['ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'].map((w): [string, number] => [w, 2]),
    ...['twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety', 'hundred', 'triple'].map((w): [string, number] => [w, 2]),
    ['thousand', 3],
]);
// A digit; a word (letters and their marks, never an invisible character such as a Hangul filler); or one other character.
const TOKEN = /(\p{Nd})|((?!\p{Default_Ignorable_Code_Point})\p{L}(?:(?!\p{Default_Ignorable_Code_Point})[\p{L}\p{M}])*)|([\s\S])/gu;
const PLUS = /[+\u{FF0B}\u{FE62}\u{207A}\u{208A}\u{2795}]/u;
const SLASH = /[\/\u{2044}\u{2215}\u{29F8}\u{FF0F}]/u;
const OPEN = /\p{Ps}/u;
const runs = new Map<number, RegExp>();

const COMMA = /[,;\u{060C}\u{061B}\u{3001}\u{FE50}\u{FE51}\u{FE54}\u{FF0C}\u{FF1B}\u{FF64}]/u;

/** At least minDigits digits with only separators or slashes between them, from a plus sign or an opening bracket. */
function numberRun(minDigits: number): RegExp {
    let pattern = runs.get(minDigits);
    if (!pattern) {
        pattern = new RegExp(String.raw`[+o]?[dw](?:[soc\/]*[dw]){${minDigits - 1},}`, 'g');
        runs.set(minDigits, pattern);
    }
    return pattern;
}

/**
 * A slash date on the shadow: 10/24, 10/2026, 10/24/26, 10/24/2026, 2026/10 or 2026/10/24, written in digits, with
 * any spacing around the slashes. Phone numbers have groups of three or more after any country code, so they never
 * take this shape. dateSpans() decides which of these are dates.
 */
const DATE = /(?<![dw\/])(?:d{1,2}s*\/s*(?:d{1,2}(?:s*\/s*(?:dddd|dd))?|dddd)|dddds*\/s*d{1,2}(?:s*\/s*d{1,2})?)(?![dw\/])/g;

const isDigit = (ch: string | undefined): boolean => ch === 'd' || ch === 'w';
const isGap = (ch: string | undefined): boolean => ch === 's' || ch === 'c' || ch === 'o';

/**
 * The date-shaped parts that are dates, to be read as words before numbers are looked for, so a date is never masked
 * and never joins a number. A digit beside one, across any separators, must belong to another date that is itself
 * accepted ("10/24 10/25") or to a time of one or two digits next to a word or a colon ("9:00", "9 am"). Any other
 * digit beside it means it is a piece of a number, as in "4  1  5/5  5  5/0  1  2  3" or "415 5/5 5/01/23". A
 * rejection is passed on to the neighbors, which are checked again. Linear: each date is checked at most three times.
 */
function dateSpans(shadow: string): [number, number][] {
    const found: [number, number][] = [];
    const owner = new Int32Array(shadow.length).fill(-1);
    for (const match of shadow.matchAll(DATE)) {
        const start = match.index ?? 0;
        const end = start + (match[0] ?? '').length;
        owner.fill(found.length, start, end);
        found.push([start, end]);
    }
    const word = (at: number) => at < 0 || at >= shadow.length || shadow[at] === 'x';
    // Beside a date: 'free' (no digit, or a short time), another date's index, or 'number'.
    const before = (start: number): number | 'free' | 'number' => {
        let at = start - 1;
        while (at >= 0 && isGap(shadow[at])) at--;
        if (at < 0 || !isDigit(shadow[at])) return 'free';
        if ((owner[at] ?? -1) >= 0) return owner[at] ?? -1;
        let first = at;
        while (first > 0 && isDigit(shadow[first - 1])) first--;
        return at - first < 2 && word(shadow[first - 1] === 's' ? first - 2 : first - 1) ? 'free' : 'number';
    };
    const after = (end: number): number | 'free' | 'number' => {
        let at = end;
        while (at < shadow.length && isGap(shadow[at])) at++;
        if (at >= shadow.length || !isDigit(shadow[at])) return 'free';
        if ((owner[at] ?? -1) >= 0) return owner[at] ?? -1;
        let last = at;
        while (last + 1 < shadow.length && isDigit(shadow[last + 1])) last++;
        return last - at < 2 && word(shadow[last + 1] === 's' ? last + 2 : last + 1) ? 'free' : 'number';
    };
    const accepted = found.map(() => true);
    const fine = (side: number | 'free' | 'number') => side === 'free' || (typeof side === 'number' && accepted[side] === true);
    const queue = found.map((_, i) => i);
    while (queue.length > 0) {
        const i = queue.pop() ?? 0;
        const span = found[i];
        if (!span || !accepted[i]) continue;
        const left = before(span[0]);
        const right = after(span[1]);
        if (fine(left) && fine(right)) continue;
        accepted[i] = false;
        if (typeof left === 'number') queue.push(left);
        if (typeof right === 'number') queue.push(right);
    }
    return found.filter((_, i) => accepted[i]);
}

function otherKind(other: string): string {
    if (other === ':') return 'x';
    if (other.length === 1 && other.charCodeAt(0) < 128) {
        // The same classes for plain ASCII, without the Unicode lookups.
        if (other === '+' || other === '/') return other;
        if (other === ',' || other === ';') return 'c';
        return other === '(' || other === '[' || other === '{' ? 'o' : 's';
    }
    if (PLUS.test(other)) return '+';
    if (SLASH.test(other)) return '/';
    if (COMMA.test(other)) return 'c';
    return OPEN.test(other) ? 'o' : 's';
}

interface Token {
    start: number;
    end: number;
    kind: string;
    /** How many digits it stands for: 1, or 2 for "fifteen", 3 for "thousand". */
    weight: number;
}

function tokenize(text: string): Token[] {
    const tokens: Token[] = [];
    for (const match of text.matchAll(TOKEN)) {
        const whole = match[0] ?? '';
        const start = match.index ?? 0;
        const word = match[2];
        const spoken = word === undefined ? undefined : NUMBER_WORDS.get(word.toLowerCase());
        const kind = match[1] !== undefined ? 'd' : spoken !== undefined ? 'w' : word !== undefined ? 'x' : otherKind(whole);
        tokens.push({ start, end: start + whole.length, kind, weight: spoken ?? 1 });
    }
    return tokens;
}

function maskSecrets(text: string): string {
    return String(text).replace(API_KEY, '[key]').replace(TOKEN_PARAM, '$1=[token]').replace(JWT_LIKE, '[token]');
}

/** The text with each run of masked tokens that holds a digit replaced by [number]. Nothing else changes. */
function rebuild(text: string, tokens: readonly Token[], masked: readonly boolean[]): string {
    let out = '';
    let at = 0;
    for (let i = 0; i < tokens.length; ) {
        if (!masked[i]) {
            i++;
            continue;
        }
        let j = i;
        let digit = false;
        while (j < tokens.length && masked[j]) {
            const kind = tokens[j]?.kind;
            if (kind === 'd' || kind === 'w') digit = true;
            j++;
        }
        if (digit) {
            out += `${text.slice(at, tokens[i]?.start ?? at)}[number]`;
            at = tokens[j - 1]?.end ?? at;
        }
        i = j;
    }
    return out + text.slice(at);
}

/**
 * Masks API keys, tokens and anything that could be a phone number: digits (in any script) or spoken number words,
 * mixed or not, however they are separated (look-alike dashes, dots, spaces, bullets, combining marks or invisible
 * characters). Nothing else in the text changes. Applied to every event, error message and call summary.
 */
export function redact(text: string): string {
    return redactAll([text])[0] ?? '';
}

/**
 * redact() over several texts read as one, so a number split across them (one transcript turn ending "415 555", the
 * next starting "0188") is masked in each. minDigits (default 7) is the shortest run masked; transcript copies use 3,
 * so a fragment shown before the rest of a number arrives is masked too.
 */
export function redactAll(texts: readonly string[], minDigits = 7): string[] {
    if (!Number.isInteger(minDigits) || minDigits < 2 || minDigits > 15) throw new RangeError('minDigits must be 2 to 15.');
    const cleaned = texts.map(maskSecrets);
    const tokens = cleaned.map(tokenize);
    // The shadow repeats each token's letter once per digit it stands for; one separator between texts.
    let shadow = '';
    const ownerText: number[] = [];
    const ownerToken: number[] = [];
    tokens.forEach((list, t) => {
        if (t > 0) {
            shadow += 's';
            ownerText.push(-1);
            ownerToken.push(-1);
        }
        list.forEach((token, i) => {
            shadow += token.kind.repeat(token.weight);
            for (let k = 0; k < token.weight; k++) {
                ownerText.push(t);
                ownerToken.push(i);
            }
        });
    });
    const masked = tokens.map((list) => list.map(() => false));
    const letters = shadow.split('');
    for (const [start, end] of dateSpans(shadow)) letters.fill('x', start, end);
    const undated = letters.join('');
    for (const match of undated.matchAll(numberRun(minDigits))) {
        const run = match[0] ?? '';
        const first = match.index ?? 0;
        for (let at = first; at < first + run.length; at++) {
            const list = masked[ownerText[at] ?? -1];
            if (list) list[ownerToken[at] ?? 0] = true;
        }
    }
    return cleaned.map((text, t) => rebuild(text, tokens[t] ?? [], masked[t] ?? []));
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
