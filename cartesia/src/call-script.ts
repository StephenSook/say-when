// The reviewed call script lives in cartesia/agent/ as plain text the team can read and paste into the Playground.
// The dialer refuses to call unless the published agent says exactly this.

import { readFileSync } from 'node:fs';

export interface AgentScript {
    /** The agent's welcome message (initial_message), spoken first on every call. */
    welcome: string;
    /** The agent's instructions prompt. */
    instructions: string;
}

/** The only dynamic variables the script may use. The dialer supplies every one of them on each call. */
export const SCRIPT_VARIABLES = ['recipient_name', 'person_name', 'callback_number', 'message'] as const;
export type ScriptVariable = (typeof SCRIPT_VARIABLES)[number];

export function loadAgentScript(dir: URL = new URL('../agent/', import.meta.url)): AgentScript {
    return {
        welcome: readFileSync(new URL('welcome.txt', dir), 'utf8'),
        instructions: readFileSync(new URL('instructions.txt', dir), 'utf8'),
    };
}

/** Whitespace and curly quotes do not count as differences when comparing with the published agent. */
export function normalizeScript(text: string): string {
    return String(text)
        .replace(/[\u2018\u2019]/g, "'")
        .replace(/[\u201C\u201D]/g, '"')
        .replace(/\s+/g, ' ')
        .trim();
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
 * What the script must say. The welcome discloses an automated assistant with an AI-generated voice calling for the
 * named person and the recording, and gives the callback number, all before the message. The instructions forbid
 * speaking as the person or making new commitments, honor "stop calling", and repeat the callback number at the end.
 */
export function checkAgentScript(script: AgentScript): string[] {
    const problems: string[] = [];
    const welcome = normalizeScript(script.welcome);
    const lower = welcome.toLowerCase();
    const message = welcome.indexOf('{{message}}');
    if (message < 0) problems.push('the welcome must deliver {{message}}');
    for (const phrase of ['automated assistant', 'ai-generated voice', 'calling for {{person_name}}', 'recorded', '{{callback_number}}']) {
        const at = lower.indexOf(phrase);
        if (at < 0) problems.push(`the welcome must say "${phrase}"`);
        else if (message >= 0 && at > message) problems.push(`the welcome must say "${phrase}" before the message`);
    }
    const instructions = normalizeScript(script.instructions);
    for (const phrase of ['You are not {{person_name}}', 'new commitments', 'will not call again', '{{callback_number}}']) {
        if (!instructions.includes(phrase)) problems.push(`the instructions must include "${phrase}"`);
    }
    for (const name of [...templateVariables(script.welcome), ...templateVariables(script.instructions)]) {
        if (!(SCRIPT_VARIABLES as readonly string[]).includes(name)) problems.push(`unknown variable {{${name}}}`);
    }
    return problems;
}
