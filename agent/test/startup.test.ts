// What reaches the terminal when the sidecar cannot start (src/startup.ts, src/main.ts): only messages written to be
// shown, never a path or a piece of a file that an outside error quotes.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { ConfigError } from '@say-when/apify-client';
import { CallConfigError } from '@say-when/cartesia/server';

import { readConfig } from '../src/config.js';
import { FormsFileError } from '../src/forms.js';
import { silentLogger } from '../src/log.js';
import { errorTag, startupFailureLine, StartupError } from '../src/startup.js';
import { wire } from '../src/wiring.js';

/** A private file name: a person's name and a phone number. */
const PRIVATE_PATH = '/nonexistent/Leonora-14155550199.json';

function leaks(line: string): boolean {
    const loose = line.toLowerCase();
    return loose.includes('leonora') || loose.includes('4155550199') || loose.includes('zorbleton');
}

function thrown(fn: () => unknown): unknown {
    try {
        fn();
    } catch (error) {
        return error;
    }
    throw new Error('expected a throw');
}

describe('startup failures', () => {
    it('reports a file error by its code, never the path it quotes', () => {
        const error = thrown(() => readFileSync(PRIVATE_PATH, 'utf8'));
        assert.match(String((error as Error).message), /Leonora/, 'the raw message does quote the path (the control)');
        const line = startupFailureLine(error);
        assert.ok(!leaks(line), line);
        assert.match(line, /\(ENOENT\)/);
        assert.equal(errorTag(error), 'ENOENT');
    });

    it('reports a JSON error by its name, never the piece of the file it quotes', () => {
        const error = thrown(() => JSON.parse('[{"name": "Leonora", "street": Zorbleton}]'));
        const line = startupFailureLine(error);
        assert.ok(!leaks(line), line);
        assert.match(line, /\(SyntaxError\)/);
    });

    it('prints the messages written to be shown, and nothing else', () => {
        for (const error of [
            new StartupError('Calls could not start: a call list could not be read (ENOENT). Check CALL_CONSENT_FILE.'),
            new FormsFileError('Form 2 needs a formKey of letters, digits, - or _.'),
            new ConfigError('APIFY_TOKEN is not set.'),
            new CallConfigError('CALL_HOLD_FILE is needed, so a hold on a contact survives a restart.'),
        ]) {
            assert.equal(startupFailureLine(error), `neurolingo-agent failed to start: ${error.message}`);
        }
        const plain = new Error('Could not open the consent list of Leonora');
        assert.ok(!leaks(startupFailureLine(plain)), 'a plain error message is never printed');
        assert.ok(!leaks(startupFailureLine('Leonora')), 'nor a thrown string');
    });

    it('turns a call list that cannot be read into a startup error that names the setting, not the file', async () => {
        const env = {
            AGENT_CALLS: 'on',
            CARTESIA_API_KEY: 'placeholder-not-a-key',
            CARTESIA_AGENT_ID: 'agent_placeholder',
            CARTESIA_FROM_NUMBER_ID: 'number_placeholder',
            CALL_CALLBACK_NUMBER: '+14155550123',
            CALL_PERSON_NAME: 'Alex',
            CALL_HOLD_FILE: '/nonexistent/holds.jsonl',
            CALL_CONSENT_FILE: PRIVATE_PATH,
        };
        const { config } = readConfig(env, '/nonexistent/.agent-token', () => true);
        assert.equal(config.calls.enabled, true);
        let failure: unknown = null;
        await wire(config, env, silentLogger, () => undefined).catch((error: unknown) => (failure = error));
        assert.ok(failure instanceof StartupError, 'the read error became a StartupError');
        const line = startupFailureLine(failure);
        assert.ok(!leaks(line), line);
        assert.match(line, /CALL_CONSENT_FILE/);
        assert.match(line, /\(ENOENT\)/);
    });

    it('asks for CALL_HOLD_FILE when calls are on', () => {
        const { problems } = readConfig({ AGENT_CALLS: 'on' }, '/nonexistent/.agent-token', () => true);
        assert.ok(problems.includes('AGENT_CALLS is on but CALL_HOLD_FILE is not set.'));
    });
});
