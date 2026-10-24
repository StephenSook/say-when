import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { ApifyHttpError, UnknownOutcomeError } from '@say-when/apify-client';

import { MAX_CLAIM_TRIES } from '../src/db/retry.js';
import { fromSubmitError, fromSubmitResult, SAY } from '../src/errands.js';
import { errandResult, harness, SECRET, settle, waitFor, type Harness } from './helpers.js';

let open: Harness | null = null;
afterEach(async () => {
    await open?.orchestrator.stop(1_000);
    open = null;
});

function start(h: Harness): Harness {
    open = h;
    h.orchestrator.start();
    return h;
}

const FIELDS = JSON.stringify([
    { label: 'Who is this from?', value: 'Alex', source: 'profile' },
    { label: 'What do you need?', value: 'Meal or drink', source: 'conversation' },
    { label: 'Details', value: SECRET.formValue, source: 'conversation' },
]);
const ERRAND = { formKey: 'care_team_request', formUrl: 'demo', formTitle: 'Care team request', fieldsJson: FIELDS };

/** A YES on an errand option: the module drafted it; the sidecar previews it. */
async function previewed(h: Harness): Promise<bigint> {
    const { jobId, errandId } = h.db.addPreviewJob(ERRAND);
    await waitFor(() => h.db.job(jobId)?.status === 'done', 3_000, 'preview attached');
    return errandId;
}

describe('the errand preview', () => {
    it('attaches the read-back and digest to the errand, and never submits', async () => {
        const h = start(harness());
        const errandId = await previewed(h);
        const errand = h.db.errands.get(errandId);
        assert.equal(errand?.status, 'previewed');
        assert.equal(errand?.previewDigest, '0123456789abcdef');
        assert.equal(errand?.readBackText, SECRET.readBack);
        assert.deepEqual(JSON.parse(errand?.readBackJson ?? '[]')[0], { label: 'Details', value: SECRET.formValue, matchedBy: 'label' });
        assert.equal(h.errands.previews.length, 1);
        assert.equal(h.errands.previews[0]?.formUrl, 'demo');
        assert.equal(h.errands.previews[0]?.fields.length, 3);
        assert.equal(h.errands.submits.length, 0);
        const event = h.db.events.find((e) => e.stage === 'errand' && e.status === 'ok');
        assert.equal(event?.detail, 'preview previewed');
    });

    it('attaches a refusal with the Actor\'s code and sentence', async () => {
        const h = start(harness());
        h.errands.previewResult = errandResult({ status: 'refused', previewDigest: null, readBackText: null, refusal: { code: 'captcha', reason: 'The form asks for a CAPTCHA, so I stopped.' } });
        const errandId = await previewed(h);
        const errand = h.db.errands.get(errandId);
        assert.equal(errand?.status, 'refused');
        assert.equal(errand?.reasonCode, 'captcha');
        assert.equal(h.db.events.find((e) => e.stage === 'errand' && e.status === 'error')?.detail, 'preview refused: captcha');
    });

    it('fails the errand when the preview breaks', async () => {
        const h = start(harness());
        h.errands.previewResult = new ApifyHttpError({ service: 'form-errand', endpoint: 'POST x/preview', kind: 'timeout', status: null, attempts: 1 });
        const errandId = await previewed(h);
        assert.equal(h.db.errands.get(errandId)?.status, 'failed');
        assert.equal(h.db.errands.get(errandId)?.reasonCode, 'preview_timeout');
    });

    it('fails fast when the form helper is not set up', async () => {
        const h = start(harness({ errands: false }));
        const errandId = await previewed(h);
        assert.equal(h.db.errands.get(errandId)?.status, 'failed');
        assert.equal(h.db.errands.get(errandId)?.reasonCode, 'errands_not_configured');
    });
});

describe('the errand submit gate', () => {
    it('submits once, only after the module shows it confirmed with the previewed digest', async () => {
        const h = start(harness());
        const errandId = await previewed(h);
        await settle(30);
        assert.equal(h.errands.submits.length, 0, 'nothing is sent before the CONFIRM');
        h.db.confirmErrand(errandId);
        await waitFor(() => h.db.errands.get(errandId)?.status === 'submitted', 3_000, 'submitted');
        assert.equal(h.errands.submits.length, 1);
        const submit = h.errands.submits[0];
        assert.equal(submit?.confirm, true);
        assert.equal(submit?.confirmDigest, '0123456789abcdef');
        assert.deepEqual(submit?.fields, JSON.parse(FIELDS));
        assert.equal(h.db.errands.get(errandId)?.confirmationText, 'Request received.');
        // Later changes to the views never send it again.
        h.db.addOptionsJob({ questionText: 'Are you tired?' });
        await settle(50);
        assert.equal(h.errands.submits.length, 1);
    });

    it('refuses a confirmed digest that is not the one it previewed, and sends nothing', async () => {
        const h = start(harness());
        const errandId = await previewed(h);
        h.db.confirmErrand(errandId, 'ffffffffffffffff');
        await waitFor(() => h.db.errands.get(errandId)?.status === 'refused', 3_000, 'refused');
        assert.equal(h.errands.submits.length, 0);
        assert.equal(h.db.errands.get(errandId)?.reasonCode, 'digest_mismatch');
        assert.equal(h.db.errands.get(errandId)?.reason, SAY.mismatch);
    });

    it('leaves alone a confirmed errand it did not preview', async () => {
        const h = start(harness());
        const errandId = h.db.addConfirmedErrand({ ...ERRAND, digest: '0123456789abcdef' });
        await settle(80);
        assert.equal(h.db.errands.get(errandId)?.status, 'confirmed');
        assert.equal(h.db.attempted.filter((a) => a.name === 'claimErrand').length, 0);
        assert.equal(h.errands.submits.length, 0);
    });

    it('records an unclear submit as unknown_outcome and never resends it', async () => {
        const h = start(harness());
        h.errands.submitResult = new UnknownOutcomeError('click_uncertain');
        const errandId = await previewed(h);
        h.db.confirmErrand(errandId);
        await waitFor(() => h.db.errands.get(errandId)?.status === 'unknown_outcome', 3_000, 'unknown outcome');
        assert.equal(h.db.errands.get(errandId)?.reasonCode, 'click_uncertain');
        assert.equal(h.db.errands.get(errandId)?.reason, SAY.unknown);
        h.db.addOptionsJob({ questionText: 'Are you tired?' });
        await settle(60);
        assert.equal(h.errands.submits.length, 1, 'never retried');
    });

    it('keeps sending the result (never the submit) until the module has it', async () => {
        const h = harness();
        h.db.failNext('completeErrand', 'disconnected', { times: 2 });
        start(h);
        const errandId = await previewed(h);
        h.db.confirmErrand(errandId);
        await waitFor(() => h.db.errands.get(errandId)?.status === 'submitted', 3_000, 'submitted');
        assert.equal(h.errands.submits.length, 1);
        assert.equal(h.db.attempted.filter((a) => a.name === 'completeErrand').length, 3);
    });

    it('does not submit when the claim is refused (the person stopped it first)', async () => {
        const h = harness();
        h.db.failNext('claimErrand', 'refused');
        start(h);
        const errandId = await previewed(h);
        h.db.confirmErrand(errandId);
        await settle(80);
        assert.equal(h.errands.submits.length, 0);
    });

    it('tries a claim again when it never reached the module, and submits once', async () => {
        const h = harness();
        // Three tries in one round, every one failing before it was sent.
        h.db.failNext('claimErrand', 'disconnected', { times: 3 });
        start(h);
        const errandId = await previewed(h);
        h.db.confirmErrand(errandId);
        await waitFor(() => h.db.errands.get(errandId)?.status === 'submitted', 3_000, 'submitted after another look');
        assert.equal(h.db.attempted.filter((a) => a.name === 'claimErrand').length, 4);
        await settle(40);
        assert.equal(h.errands.submits.length, 1);
    });

    it('stops trying after MAX_CLAIM_TRIES rounds that never reached the module, and sends nothing', async () => {
        const h = harness();
        h.db.failNext('claimErrand', 'disconnected', { times: 3 * MAX_CLAIM_TRIES + 3 });
        start(h);
        const errandId = await previewed(h);
        h.db.confirmErrand(errandId);
        const claims = () => h.db.attempted.filter((a) => a.name === 'claimErrand').length;
        await waitFor(() => claims() === 3 * MAX_CLAIM_TRIES, 3_000, 'every round');
        await settle(60);
        assert.equal(claims(), 3 * MAX_CLAIM_TRIES);
        assert.equal(h.errands.submits.length, 0);
        assert.equal(h.db.errands.get(errandId)?.status, 'confirmed');
    });

    it('maps submit results and errors without claiming "not sent" unless that is proven', () => {
        assert.equal(fromSubmitResult(errandResult({ status: 'submitted', confirmationText: 'ok' })).status, 'submitted');
        assert.equal(fromSubmitResult(errandResult({ status: 'duplicate', confirmationText: 'ok' })).status, 'duplicate');
        const refused = fromSubmitResult(errandResult({ status: 'refused', refusal: { code: 'digest_mismatch', reason: 'The page changed, so I did not send it.' } }));
        assert.deepEqual([refused.status, refused.reasonCode], ['refused', 'digest_mismatch']);
        assert.equal(fromSubmitError(new UnknownOutcomeError('timeout')).status, 'unknown');
        assert.equal(fromSubmitError(new ApifyHttpError({ service: 'form-errand', endpoint: 'POST x/submit', kind: 'http', status: 402, attempts: 1 })).status, 'failed');
        assert.equal(fromSubmitError(new TypeError('bad digest')).status, 'failed');
        assert.equal(fromSubmitError(new Error('something odd')).status, 'unknown');
    });
});
