// Voices, tones and the exact transcript for each utterance. Pure: used by the browser player and by tests.

/** Emotion values this package sends. All five are in the TTS WebSocket schema enum for generation_config.emotion. */
export type Emotion = 'neutral' | 'calm' | 'content' | 'sad' | 'angry';

export const TONES = ['neutral', 'calm', 'warm', 'sad', 'firm'] as const;
export type Tone = (typeof TONES)[number];

/**
 * Each tone sends one generation_config.emotion value. Emotion is Beta and English only, and it only works when the
 * words already carry the tone, so the planner writes the words in that tone too.
 */
export const TONE_EMOTION: Readonly<Record<Tone, Emotion>> = {
    neutral: 'neutral',
    calm: 'calm',
    warm: 'content',
    sad: 'sad',
    firm: 'angry',
};

/** Skylar: on the Sonic 3.6 page's list of stable voices for agents; the List Voices example shows an es-MX accent. */
export const SKYLAR_VOICE_ID = 'db6b0ed5-d5d3-463d-ae85-518a07d3c2b4';
/** Daniel: also on the Sonic 3.6 page's list of stable voices for agents. */
export const DANIEL_VOICE_ID = '47c38ca4-5f35-497b-b1a3-415245fb35e1';
/** Tessa: on the Volume, Speed, and Emotion page's list of voices with the best emotional response. */
export const TESSA_VOICE_ID = '6ccbfb76-1fc6-48f7-b71d-91ac6298247b';

/** Library voices only. Audition others with `npm run voices` and swap the ids here or through the profile. */
export const DEFAULT_VOICES = { assistant: SKYLAR_VOICE_ID, reply: TESSA_VOICE_ID } as const;

export type UtteranceKind = 'option' | 'reply' | 'prompt' | 'readback';

export interface VoiceProfile {
    /** Steady voice for prompts and read-backs in the earpiece. */
    assistantVoiceId: string;
    /** Warm, expressive voice for options and the chosen reply, so the person hears the tone they pick. */
    replyVoiceId: string;
    /** The person's own listening pace for prompts and read-backs: generation_config.speed, 0.6 to 1.5. */
    assistantSpeed: number;
    /** Pace for options in the earpiece. Unset means the voice's natural pace. */
    optionSpeed?: number;
    /** Loudness of the reply in the room: generation_config.volume, 0.5 to 2.0. */
    replyVolume?: number;
    /**
     * Off unless set. A locale such as "es-MX" makes replies speak that language for a partner who speaks it.
     * Emotion and laughter are dropped for non-English replies. The planner must write the reply in that language.
     */
    partnerLocale?: string;
}

export class SpeechMarkupError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SpeechMarkupError';
    }
}

const SPEED = [0.6, 1.5] as const;
const VOLUME = [0.5, 2] as const;

function inRange(value: number, [min, max]: readonly [number, number]): boolean {
    return Number.isFinite(value) && value >= min && value <= max;
}

export function voiceProfile(overrides: Partial<VoiceProfile> = {}): VoiceProfile {
    const profile: VoiceProfile = {
        assistantVoiceId: DEFAULT_VOICES.assistant,
        replyVoiceId: DEFAULT_VOICES.reply,
        assistantSpeed: 1,
        ...overrides,
    };
    if (!profile.assistantVoiceId.trim() || !profile.replyVoiceId.trim()) throw new RangeError('Voice ids cannot be empty.');
    for (const [name, value] of [['assistantSpeed', profile.assistantSpeed], ['optionSpeed', profile.optionSpeed]] as const) {
        if (value !== undefined && !inRange(value, SPEED)) throw new RangeError(`${name} must be 0.6 to 1.5.`);
    }
    if (profile.replyVolume !== undefined && !inRange(profile.replyVolume, VOLUME)) throw new RangeError('replyVolume must be 0.5 to 2.');
    if (profile.partnerLocale !== undefined && !/^[a-z]{2}(-[A-Z]{2})?$/.test(profile.partnerLocale)) {
        throw new RangeError('partnerLocale looks like "es" or "es-MX".');
    }
    return profile;
}

export function toTone(value: unknown): Tone | null {
    if (typeof value !== 'string') return null;
    const lower = value.trim().toLowerCase();
    return (TONES as readonly string[]).includes(lower) ? (lower as Tone) : null;
}

/** Removes markup from untrusted text: SSML-style tags, bracket tags like [laughter], and stray brackets. */
export function cleanText(text: string): string {
    return String(text)
        .replace(/<[^>]*>/g, ' ')
        .replace(/\[[^\]]*\]/g, ' ')
        .replace(/[<>[\]{}]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/** The buffering guide: without closing punctuation the model may wait for more text before it speaks. */
export function endPunctuation(text: string): string {
    return text === '' || /[.!?]$/.test(text) ? text : `${text}.`;
}

/** Part of a read-back: plain text (cleaned), a code read out letter by letter, or a short pause. */
export type Segment = string | { spell: string } | { pauseMs: number };

/** Read a code character by character with Sonic's <spell> tag. Punctuation is dropped, as the docs advise. */
export const spell = (code: string): Segment => ({ spell: code });
/** An explicit pause with Sonic's <break> tag. Punctuation is usually enough; use this sparingly. */
export const pause = (ms: number): Segment => ({ pauseMs: ms });

export function renderSegments(segments: readonly Segment[]): string {
    const parts: string[] = [];
    let last: 'text' | 'spell' | 'pause' | null = null;
    for (const segment of segments) {
        if (typeof segment === 'string') {
            const text = cleanText(segment);
            if (!text) continue;
            parts.push(text);
            last = 'text';
        } else if ('spell' in segment) {
            const code = String(segment.spell).replace(/[^A-Za-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
            if (!code || code.length > 40) throw new SpeechMarkupError('A spelled code needs 1 to 40 letters or digits.');
            // The SSML guide: do not chain <spell> and <break> tags.
            if (last === 'pause') throw new SpeechMarkupError('Put words between a pause and a spelled code.');
            parts.push(`<spell>${code}</spell>`);
            last = 'spell';
        } else {
            const ms = segment.pauseMs;
            if (!Number.isInteger(ms) || ms < 100 || ms > 3000) throw new SpeechMarkupError('A pause is 100 to 3000 ms.');
            if (last === 'spell') throw new SpeechMarkupError('Put words between a spelled code and a pause.');
            if (last === 'pause') throw new SpeechMarkupError('Two pauses in a row can make the model hallucinate.');
            parts.push(`<break time="${ms}ms"/>`);
            last = 'pause';
        }
    }
    let out = parts.join(' ');
    if (last === 'text') out = endPunctuation(out);
    if (last === 'spell') out = `${out}.`;
    return out;
}

export interface GenerationConfig {
    emotion?: Emotion;
    speed?: number;
    volume?: number;
}

/** One thing to say, with every field the TTS request needs. Exactly one of `language` and `locale` is set. */
export interface Utterance {
    kind: UtteranceKind;
    transcript: string;
    voiceId: string;
    language?: 'en';
    locale?: string;
    generationConfig: GenerationConfig;
    /** The tone actually applied, for the tone chip; null when none was. */
    tone: Tone | null;
    laugh: boolean;
}

export interface UtteranceInput {
    kind: UtteranceKind;
    text?: string;
    segments?: readonly Segment[];
    tone?: string | null;
    laugh?: boolean;
}

const isEnglish = (locale: string): boolean => locale.toLowerCase().startsWith('en');

/**
 * Picks the voice and generation_config for one utterance. Options and replies use the reply voice with their tone
 * and an optional laugh; prompts and read-backs use the steady assistant voice at the person's pace, with no tone.
 * An unknown tone sends no emotion rather than a guess, so the person never hears a tone they did not pick.
 */
export function utterance(input: UtteranceInput, profile: VoiceProfile): Utterance {
    const expressive = input.kind === 'option' || input.kind === 'reply';
    const locale = input.kind === 'reply' ? profile.partnerLocale : undefined;
    const foreign = locale !== undefined && !isEnglish(locale);
    let transcript = input.segments ? renderSegments(input.segments) : endPunctuation(cleanText(input.text ?? ''));
    if (!transcript) throw new SpeechMarkupError('There is nothing to say.');
    // Emotion is English only. Laughter is only shown in English examples, so it is dropped for other languages too.
    const tone = expressive && !foreign ? toTone(input.tone) : null;
    const laugh = expressive && !foreign && input.laugh === true;
    if (laugh) transcript = `${transcript} [laughter]`;
    const generationConfig: GenerationConfig = {};
    if (tone) generationConfig.emotion = TONE_EMOTION[tone];
    if (!expressive && profile.assistantSpeed !== 1) generationConfig.speed = profile.assistantSpeed;
    if (input.kind === 'option' && profile.optionSpeed !== undefined) generationConfig.speed = profile.optionSpeed;
    if (input.kind === 'reply' && profile.replyVolume !== undefined) generationConfig.volume = profile.replyVolume;
    const out: Utterance = {
        kind: input.kind,
        transcript,
        voiceId: expressive ? profile.replyVoiceId : profile.assistantVoiceId,
        generationConfig,
        tone,
        laugh,
    };
    if (locale !== undefined) out.locale = locale;
    else out.language = 'en';
    return out;
}

/**
 * Short prompts worth caching once per session. Spoken in the assistant voice. `noneOfThese` and `paused` follow a
 * STOP, `headsetOff` a HEADSET_OFF; the wording matches the banners in docs/ui.md (PLAN D11).
 */
export const STOCK_PHRASES = {
    noneOfThese: 'None of these.',
    repeat: 'Hear the options again.',
    oneMoment: 'One moment.',
    paused: 'Paused. Nothing will be sent.',
    headsetOff: 'Headset off. Nothing will be sent.',
    cancelled: 'Cancelled. Nothing was sent.',
    notSent: 'Not sent.',
    sent: 'Sent.',
} as const;

export type StockPhrase = keyof typeof STOCK_PHRASES;

export function stockUtterance(phrase: StockPhrase, profile: VoiceProfile): Utterance {
    return utterance({ kind: 'prompt', text: STOCK_PHRASES[phrase] }, profile);
}

export function stockUtterances(profile: VoiceProfile): Utterance[] {
    return (Object.keys(STOCK_PHRASES) as StockPhrase[]).map((phrase) => stockUtterance(phrase, profile));
}
