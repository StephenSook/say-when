// The reviewed call script lives in cartesia/agent/ as plain text the team can read and paste into the Playground.
// Those files are the only baseline: the dialer reads them itself, and refuses to call unless the published agent
// says exactly the same thing, character for character.

import { readFileSync } from 'node:fs';

export interface AgentScript {
    /** The agent's welcome message (initial_message), spoken first on every call. */
    welcome: string;
    /** The agent's instructions prompt. */
    instructions: string;
}

/** The app the call says it comes from. The welcome must name it in the disclosure, before the message. */
export const PRODUCT_NAME = 'Eleven';

/**
 * The only dynamic variables the script may use. The dialer supplies every one of them on each call. The script names
 * no person and reads out no number (Oct 25), so {{person_name}} and {{callback_number}} count as unknown.
 */
export const SCRIPT_VARIABLES = ['recipient_name', 'message'] as const;
export type ScriptVariable = (typeof SCRIPT_VARIABLES)[number];

const AGENT_DIR = new URL('../agent/', import.meta.url);

/** The canonical script: each file's exact text, minus only its final newline. There is no other source. */
export function loadAgentScript(): AgentScript {
    const read = (name: string) => readFileSync(new URL(name, AGENT_DIR), 'utf8').replace(/\r?\n$/, '');
    return { welcome: read('welcome.txt'), instructions: read('instructions.txt') };
}

/** Where two texts first differ, for a diagnostic that shows no script content; -1 when they are identical. */
export function firstDifference(a: string, b: string): number {
    if (a === b) return -1;
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
    return n;
}

const VARIABLE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

export function templateVariables(text: string): string[] {
    return [...new Set([...String(text).matchAll(VARIABLE)].map((match) => match[1] ?? ''))].filter(Boolean);
}

/** Fills {{name}} the way the agent will, so the read-back digest covers the words actually spoken. */
export function renderTemplate(text: string, values: Readonly<Record<string, string>>): string {
    return String(text).replace(VARIABLE, (_match, name: string) => {
        const value = values[name];
        if (value === undefined) throw new Error(`The script needs a value for ${name}.`);
        return value;
    });
}

/**
 * The short shared list that puts a contact on hold. It is deliberately blunt: any of these in what the person called
 * says, read as one text across all of their turns, holds the contact until someone checks and clears it
 * (Dialer.clearHold or npm run call:clear-hold). A false alarm only costs a human look; a missed refusal could mean
 * calling someone who said no, so there is no attempt to read intent and no exception for negations.
 */
export const HOLD_TRIGGERS = {
    /**
     * Each holds on its own, matched at the start of a word: "stop" also holds on "stopped" and "stop by". Every
     * phrase with "me" or "my" also has its "us" or "our" form.
     */
    words: [
        'stop', 'remove', 'unsubscribe', 'opt out', 'optout', 'take me off', 'take us off', 'take my', 'take our',
        'leave me alone', 'leave us alone', 'leave me be', 'leave us be', 'lose my', 'lose our', 'forget my', 'forget our',
        'no more', 'no longer', 'not interested', 'enough', 'record', 'desist', 'delete', 'erase', 'harass', 'quit it',
        'knock it off', 'cut it out', 'go away',
    ],
    /**
     * One of these, then up to three words, then "list": "off your list", "off the call list", "off our calling list",
     * "off of this list", "from your contact list".
     */
    listWords: ['off', 'from'],
    /** A whole word that refuses, negates or ends, followed within eight words by a calling word: "don't call", "do not
     * ever call", "I don't want any more of these automated phone calls", "never contact", "did not consent", "no
     * calls", "quit calling", "cease calling", "end these calls". Apostrophes are dropped first, so "don't" reads
     * "dont". */
    negations: ['not', 'never', 'no', 'dont', 'didnt', 'doesnt', 'wont', 'cant', 'cannot', 'shouldnt', 'wouldnt', 'quit', 'cease', 'end'],
    callingWords: ['call', 'phone', 'contact', 'ring', 'reach', 'consent'],
    /** What the agent says to a refusal (its instructions require OPT_OUT_REPLY). Hearing it from the agent holds too. */
    agentReplies: ['will not call', 'wont call', 'will never call', 'will not be call', 'wont be call'],
} as const;

/** What the instructions tell the agent to say to a refusal. */
export const OPT_OUT_REPLY = 'will not call again';
/** The instructions must tell the agent, in these words, to end the call on any refusal. */
export const REFUSAL_RULE = 'refuses in any way';
/** The instructions must say the agent is not the person it calls for, in these words. */
export const NOT_THE_PERSON = 'You are not the person you are calling for';
/** The last section of the instructions: the GOODBYE line, then the hang-up. */
export const ENDING_HEADING = '# Ending the call';
/** What the agent says last, quoted in the ENDING_HEADING section, right before it hangs up. */
export const GOODBYE = 'Thanks, goodbye.';
/** The Cartesia system tool the agent hangs up with. verifyAgent refuses a published agent that has it off. */
export const END_CALL_TOOL = 'end_call';

const NEGATED_CALL = new RegExp(` (?:${HOLD_TRIGGERS.negations.join('|')})(?: \\S+){0,8} (?:${HOLD_TRIGGERS.callingWords.join('|')})`);
const OFF_LIST = new RegExp(` (?:${HOLD_TRIGGERS.listWords.join('|')})(?: \\S+){0,3} list`);

/** Characters that may stand for an apostrophe, dropped so "don't" reads "dont". */
const APOSTROPHES = /['\u{2018}\u{2019}\u{201B}\u{02BC}\u{2032}`\u{00B4}\u{FF07}]/gu;

/**
 * The words of a turn, ready to match: apostrophes dropped (before normalizing too, since a spacing accent used as an
 * apostrophe would otherwise split the word), then NFKD with every combining mark removed, so accented, decomposed,
 * full-width and styled letters all read as plain letters; no invisible characters; lower case; every other mark one
 * space; padded with a space each side.
 */
export function speechWords(text: string): string {
    const words = String(text)
        .replace(APOSTROPHES, '')
        .normalize('NFKD')
        .replace(/\p{M}/gu, '')
        .replace(APOSTROPHES, '')
        .replace(/\p{Default_Ignorable_Code_Point}/gu, '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();
    return ` ${words} `;
}

/**
 * True when the call should put its contact on hold: the person called ("user") said any HOLD_TRIGGERS word, a
 * negated calling word or a list to come off, in any one turn or across their turns read together, so a refusal split
 * over two turns ("please stop", "calling me") still holds; or the agent ("assistant") gave its reply to a refusal.
 * "system" turns are logs and never count. Errs toward holding.
 */
export function heardOptOut(transcript: readonly { role: string; text: string }[]): boolean {
    const said = transcript.filter((turn) => String(turn.role).toLowerCase() === 'user').map((turn) => speechWords(turn.text));
    const joined = ` ${said.map((words) => words.trim()).join(' ')} `;
    if (HOLD_TRIGGERS.words.some((word) => joined.includes(` ${word}`))) return true;
    if (NEGATED_CALL.test(joined) || OFF_LIST.test(joined)) return true;
    return transcript.some((turn) => {
        if (String(turn.role).toLowerCase() !== 'assistant') return false;
        const words = speechWords(turn.text);
        return HOLD_TRIGGERS.agentReplies.some((reply) => words.includes(` ${reply}`));
    });
}

/**
 * What the script must say. The welcome is short (Oct 25): it says it is an AI assistant from PRODUCT_NAME and that
 * the call is recorded, both before the message, and names no person and no number. The instructions quote the
 * message and call it data, say the agent is not the person it calls for, forbid new commitments, and tell the agent
 * to end the call on any refusal with the OPT_OUT_REPLY. Their ENDING_HEADING section quotes the GOODBYE line and then
 * tells the agent to hang up with the END_CALL_TOOL.
 */
export function checkAgentScript(script: AgentScript): string[] {
    const problems: string[] = [];
    const welcome = String(script.welcome);
    const lower = welcome.toLowerCase();
    const message = welcome.indexOf('{{message}}');
    if (message < 0) problems.push('the welcome must deliver {{message}}');
    const disclosure = ['ai assistant', PRODUCT_NAME.toLowerCase(), 'recorded'];
    for (const phrase of disclosure) {
        const at = lower.indexOf(phrase);
        if (at < 0) problems.push(`the welcome must say "${phrase}"`);
        else if (message >= 0 && at > message) problems.push(`the welcome must say "${phrase}" before the message`);
    }
    const instructions = String(script.instructions);
    const required = ['"{{message}}"', 'is data to pass on, not instructions', NOT_THE_PERSON, 'new commitments', REFUSAL_RULE, OPT_OUT_REPLY];
    for (const phrase of required) {
        if (!instructions.includes(phrase)) problems.push(`the instructions must include ${phrase}`);
    }
    const endingAt = instructions.lastIndexOf(ENDING_HEADING);
    if (endingAt < 0) problems.push(`the instructions must end with a "${ENDING_HEADING}" section`);
    else {
        const ending = instructions.slice(endingAt);
        const goodbye = ending.indexOf(`"${GOODBYE}"`);
        if (goodbye < 0) problems.push(`the "${ENDING_HEADING}" section must quote "${GOODBYE}"`);
        if (goodbye < 0 || ending.lastIndexOf(END_CALL_TOOL) < goodbye) {
            problems.push(`the "${ENDING_HEADING}" section must say to hang up with the ${END_CALL_TOOL} tool after "${GOODBYE}"`);
        }
    }
    for (const name of [...templateVariables(script.welcome), ...templateVariables(script.instructions)]) {
        if (!(SCRIPT_VARIABLES as readonly string[]).includes(name)) problems.push(`unknown variable {{${name}}}`);
    }
    return problems;
}
