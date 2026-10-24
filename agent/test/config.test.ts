import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadEnvFiles, readConfig } from '../src/config.js';
import { FormsFileError, loadForms, parseForms } from '../src/forms.js';

const VALUES = {
    ANTHROPIC_API_KEY: 'sk-ant-SECRETVALUE-123',
    APIFY_TOKEN: 'apify_api_SECRETVALUE',
    FORM_ERRAND_URL: 'https://secret-standby.apify.actor',
    MOSS_PROJECT_ID: 'moss-SECRETVALUE-id',
    MOSS_PROJECT_KEY: 'moss-SECRETVALUE-key',
    MOSS_SNAPSHOT_DIR: '/tmp/moss-SECRETVALUE',
    SPACETIMEDB_DB: 'say-when-demo',
};

/** A token file in a folder that exists, not written yet. */
const NO_TOKEN_YET = join(tmpdir(), 'neurolingo-agent-test-no-token');

describe('settings', () => {
    it('reports each setting by name and state, never by value', () => {
        const { checks, problems, config } = readConfig(VALUES, NO_TOKEN_YET);
        assert.deepEqual(problems, []);
        const text = JSON.stringify(checks);
        for (const value of Object.values(VALUES)) if (value !== 'say-when-demo') assert.ok(!text.includes(value), 'a value reached the checks');
        assert.ok(checks.some((c) => c.name === 'ANTHROPIC_API_KEY' && c.state === 'set'));
        assert.equal(config.spacetime.database, 'say-when-demo');
        assert.equal(config.search.enabled, true);
        assert.equal(config.errands.enabled, true);
        assert.equal(config.moss.enabled, true);
        assert.equal(config.calls.enabled, false);
        assert.equal(config.planner.model, 'claude-haiku-5-5');
    });

    it('turns pieces off when their settings are missing, and says why', () => {
        const { checks, problems, config } = readConfig({}, NO_TOKEN_YET, () => true);
        assert.deepEqual(problems, []);
        assert.equal(checks.find((c) => c.name === 'ANTHROPIC_API_KEY')?.note, 'using the ant auth login profile');
        assert.equal(config.search.enabled, false);
        assert.equal(config.moss.enabled, false);
        assert.equal(config.spacetime.database, 'say-when-dev');
        assert.match(checks.find((c) => c.name === 'APIFY_TOKEN')?.note ?? '', /no web search and no errands/);
        assert.match(checks.find((c) => c.name === 'AGENT_TOKEN_FILE')?.note ?? '', /npm run pair/);
    });

    it('stops when the token file is in a folder that does not exist, since the identity could not be saved', () => {
        const { checks, problems } = readConfig({}, '/nonexistent/.agent-token', () => true);
        assert.ok(problems.includes('AGENT_TOKEN_FILE is in a folder that does not exist.'));
        assert.equal(checks.find((c) => c.name === 'AGENT_TOKEN_FILE')?.state, 'invalid');
    });

    it('stops on a malformed value, naming the variable', () => {
        const { problems } = readConfig(
            {
                SPACETIMEDB_DB: 'Not A Name',
                AGENT_PLANNER_MODEL: 'gpt-4',
                AGENT_PLANNER_EFFORT: 'max',
                AGENT_PLANNER_TIMEOUT_MS: '99',
                AGENT_PLACES_NEAR: 'north pole',
                AGENT_CALLS: 'maybe',
                AGENT_MOSS: 'on',
                AGENT_TIME_ZONE: 'Mars/Olympus',
            },
            '/x',
        );
        for (const name of ['SPACETIMEDB_DB', 'AGENT_PLANNER_MODEL', 'AGENT_PLANNER_EFFORT', 'AGENT_PLANNER_TIMEOUT_MS', 'AGENT_PLACES_NEAR', 'AGENT_CALLS', 'AGENT_MOSS', 'AGENT_TIME_ZONE']) {
            assert.ok(problems.some((p) => p.includes(name)), `${name} was not reported`);
        }
        assert.ok(!problems.join(' ').includes('gpt-4') && !problems.join(' ').includes('Olympus'), 'values are never echoed');
    });

    it('does not start without Anthropic credentials', () => {
        const { problems } = readConfig({}, '/x', () => false);
        assert.ok(problems.some((p) => p.includes('ANTHROPIC_API_KEY')));
        assert.deepEqual(readConfig({ ANTHROPIC_AUTH_TOKEN: 'tok' }, '/x', () => false).problems, []);
    });

    it('fails an Options job with no question text, before any search or planner call', async () => {
        const { harness, waitFor } = await import('./helpers.js');
        const h = harness();
        h.orchestrator.start();
        const jobId = h.db.addOptionsJob({ questionText: '   ' });
        await waitFor(() => h.db.job(jobId)?.status === 'failed');
        assert.equal((h.db.applied.find((a) => a.name === 'agentFail')?.args as { reasonCode: string }).reasonCode, 'empty_question');
        assert.equal(h.api.calls.length + h.search.calls.length, 0);
        await h.orchestrator.stop(500);
    });

    it('needs every call setting before calls can be turned on', () => {
        const { problems } = readConfig({ AGENT_CALLS: 'on' }, '/x');
        for (const name of ['CARTESIA_API_KEY', 'CARTESIA_AGENT_ID', 'CARTESIA_FROM_NUMBER_ID', 'CALL_CALLBACK_NUMBER', 'CALL_PERSON_NAME', 'CALL_HOLD_FILE']) {
            assert.ok(problems.some((p) => p.includes(name)), name);
        }
    });

    it('loads .env.local files without overriding what is already set', () => {
        const dir = mkdtempSync(join(tmpdir(), 'agent-env-'));
        const first = join(dir, 'a.env');
        const second = join(dir, 'b.env');
        writeFileSync(first, 'ONE=from-a\nTWO=from-a\n');
        writeFileSync(second, 'TWO=from-b\nTHREE=from-b\n');
        const env: Record<string, string | undefined> = { ONE: 'already' };
        const loaded = loadEnvFiles([first, second, join(dir, 'missing.env')], env);
        assert.equal(loaded.length, 2);
        assert.deepEqual(env, { ONE: 'already', TWO: 'from-a', THREE: 'from-b' });
    });
});

describe('the forms file', () => {
    const demo = {
        formKey: 'care_team_request',
        formUrl: 'demo',
        formTitle: 'Care team request',
        fields: [
            { label: 'Who is this from?', fixedValue: 'Alex' },
            { label: 'What do you need?', choices: ['Ride', 'Meal or drink'], required: true },
            { label: 'Details', hint: 'a few words' },
        ],
    };

    it('ships a valid example for the Actor\'s built-in demo form', () => {
        const forms = loadForms(fileURLToPath(new URL('../forms.example.json', import.meta.url)));
        assert.equal(forms.length, 1);
        assert.equal(forms[0]?.formUrl, 'demo');
        assert.ok(forms[0]?.fields.some((f) => f.required));
    });

    it('reads the allowed forms', () => {
        const forms = parseForms(JSON.stringify([demo]));
        assert.equal(forms[0]?.formKey, 'care_team_request');
        assert.equal(forms[0]?.fields[0]?.fixedValue, 'Alex');
        assert.deepEqual(forms[0]?.fields[1]?.choices, ['Ride', 'Meal or drink']);
    });

    it('refuses a bad form by position, never quoting it', () => {
        const cases = [
            { ...demo, formKey: 'bad key!' },
            { ...demo, formUrl: 'http://plain.example.com' },
            { ...demo, formTitle: '<script>' },
            { ...demo, fields: [] },
            { ...demo, fields: [{ label: 'Same' }, { label: 'same' }] },
        ];
        for (const bad of cases) {
            assert.throws(
                () => parseForms(JSON.stringify([demo, bad])),
                (e: unknown) => e instanceof FormsFileError && e.message.startsWith('Form 1') && !e.message.includes('script'),
            );
        }
        assert.throws(() => parseForms(JSON.stringify([demo, demo])), /repeats a formKey/);
        assert.throws(() => parseForms('not json'), /not valid JSON/);
    });
});
