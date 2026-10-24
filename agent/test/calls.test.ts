import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, describe, it } from 'node:test';

import {
    cancelReasonOf,
    CLOCK_SKEW_MS,
    CONFIRM_MAX_AGE_MS,
    CONFIRM_TO_DIAL_MS,
    CONFIRM_TO_PLACE_MS,
    EXPIRED_SAY,
    finalReport,
    lateReason,
    lineRole,
    OFFLINE_SAY,
    UNCHECKED_SAY,
} from '../src/calls.js';
import { MAX_CLAIM_TRIES } from '../src/db/retry.js';
import { harness, SECRET, settle, snapshot, waitFor, type Harness } from './helpers.js';

let open: Harness | null = null;
afterEach(async () => {
    open?.dialer.handle?.finish({ result: 'cancelled' });
    await open?.orchestrator.stop(1_000);
    open = null;
});

function start(h: Harness): Harness {
    open = h;
    h.orchestrator.start();
    return h;
}

const CALL = { requestId: 'call-test-1', contactId: 'leon', digest: 'fedcba9876543210' };

describe('the call path', () => {
    it('claims a confirmed call, dials once with its digest, and reports each phase and line in order', async () => {
        const h = start(harness());
        const callId = h.db.addConfirmedCall(CALL);
        await waitFor(() => h.dialer.placed.length === 1, 3_000, 'placed');
        assert.deepEqual(h.dialer.placed[0], { requestId: 'call-test-1', digest: 'fedcba9876543210' });
        assert.equal(h.db.calls.get(callId)?.status, 'dialing');
        h.callRunner.onSnapshot(snapshot('call-test-1', 'ringing'));
        h.callRunner.onSnapshot(
            snapshot('call-test-1', 'connected', [
                { role: 'assistant', text: 'Hi, this is an automated assistant for Alex.' },
                { role: 'user', text: `Got it, call me at [number].` },
            ]),
        );
        await waitFor(() => h.db.callLines.length === 2, 3_000, 'lines');
        assert.equal(h.db.calls.get(callId)?.status, 'connected');
        h.dialer.handle?.finish({ result: 'answered', endReason: 'agent_hangup' });
        await waitFor(() => h.db.calls.get(callId)?.status === 'ended', 3_000, 'ended');
        assert.equal(h.db.calls.get(callId)?.result, 'answered');
        assert.deepEqual(
            h.db.callLines.map((l) => l.role),
            ['assistant', 'recipient'],
        );
        assert.equal(h.dialer.placed.length, 1, 'one CONFIRM, one call');
    });

    it('hangs up on STOP during the call', async () => {
        const h = start(harness());
        const callId = h.db.addConfirmedCall(CALL);
        await waitFor(() => h.dialer.placed.length === 1);
        h.db.requestCallCancel(callId, 'stop');
        await waitFor(() => h.dialer.cancels.length === 1, 3_000, 'cancelled');
        assert.deepEqual(h.dialer.cancels, ['stop']);
        h.dialer.handle?.finish({ result: 'cancelled', endReason: 'api_cancelled', cancelReason: 'stop' });
        await waitFor(() => h.db.calls.get(callId)?.status === 'ended');
        assert.equal(h.db.calls.get(callId)?.result, 'cancelled');
    });

    it('passes HEADSET_OFF through as the Dialer\'s headset_off', async () => {
        const h = start(harness());
        const callId = h.db.addConfirmedCall(CALL);
        await waitFor(() => h.dialer.placed.length === 1);
        h.db.requestCallCancel(callId, 'headset_off');
        await waitFor(() => h.dialer.cancels.length === 1);
        assert.deepEqual(h.dialer.cancels, ['headset_off']);
    });

    it('never dials when STOP arrived while the claim was out', async () => {
        const h = start(harness());
        let callId = 0n;
        // The claim lands, and the cancel is already on the row when the sidecar looks again.
        const realCall = h.db.call.bind(h.db);
        h.db.call = (async (name: string, args: unknown) => {
            await realCall(name as never, args as never);
            if (name === 'claimCall') h.db.requestCallCancel(callId, 'stop');
        }) as typeof h.db.call;
        callId = h.db.addConfirmedCall(CALL);
        await waitFor(() => h.db.calls.get(callId)?.status === 'ended', 3_000, 'ended');
        assert.equal(h.dialer.placed.length, 0);
        assert.equal(h.db.calls.get(callId)?.result, 'cancelled');
    });

    it('hangs up a call whose dial lease lapsed, as the module asks', async () => {
        const h = start(harness());
        const callId = h.db.addConfirmedCall(CALL);
        await waitFor(() => h.dialer.placed.length === 1, 3_000, 'placed');
        // The module lost track of the call (its dial lease ran out): Failed, still in view, with a cancel request.
        h.db.lapseCallLease(callId);
        await waitFor(() => h.dialer.cancels.length === 1, 3_000, 'hung up');
        assert.deepEqual(h.dialer.cancels, ['operator']);
    });

    it('reports the Dialer\'s refusal with its code', async () => {
        const h = start(harness());
        h.dialer.refusePlace = true;
        const callId = h.db.addConfirmedCall(CALL);
        await waitFor(() => h.db.calls.get(callId)?.status === 'refused', 3_000, 'refused');
        assert.equal(h.db.calls.get(callId)?.reasonCode, 'do_not_call');
    });

    it('does nothing for a call that was stopped before it was claimed', async () => {
        const h = harness();
        const callId = h.db.addConfirmedCall(CALL);
        h.db.requestCallCancel(callId, 'stop');
        start(h);
        await settle(60);
        assert.equal(h.dialer.placed.length, 0);
        assert.equal(h.db.attempted.filter((a) => a.name === 'claimCall').length, 0);
    });

    it('refuses a confirmed call that was already there at startup, whose age is unknown, and never dials it', async () => {
        const h = harness();
        const callId = h.db.addConfirmedCall(CALL);
        start(h);
        await waitFor(() => h.db.calls.get(callId)?.status === 'refused', 3_000, 'refused');
        assert.equal(h.db.calls.get(callId)?.reasonCode, 'confirm_expired');
        assert.equal(h.db.calls.get(callId)?.reason, EXPIRED_SAY);
        assert.equal(h.dialer.placed.length, 0);
    });

    it('refuses a confirmed call first seen after a reconnect', async () => {
        const h = start(harness());
        await settle(10);
        h.db.setConnected(false);
        const callId = h.db.addConfirmedCall(CALL);
        await settle(20);
        assert.equal(h.db.attempted.filter((a) => a.name === 'claimCall').length, 0, 'nothing is seen while disconnected');
        h.db.setConnected(true);
        await waitFor(() => h.db.calls.get(callId)?.status === 'refused', 3_000, 'refused');
        assert.equal(h.db.calls.get(callId)?.reasonCode, 'confirm_expired');
        assert.equal(h.dialer.placed.length, 0);
    });

    it('refuses a call whose CONFIRM is too old by the module\'s clock, though the update arrived just now', async () => {
        const h = start(harness());
        // The view update was held up (a stalled connection, no reconnect): first seen now, confirmed long ago.
        const callId = h.db.addConfirmedCall({ ...CALL, confirmedAtMs: Date.now() - CONFIRM_MAX_AGE_MS - 20_000 });
        await waitFor(() => h.db.calls.get(callId)?.status === 'refused', 3_000, 'refused');
        assert.equal(h.db.calls.get(callId)?.reasonCode, 'confirm_expired');
        assert.equal(h.dialer.placed.length, 0);
    });

    it('dials a call confirmed a little while ago by the module\'s clock', async () => {
        const h = start(harness());
        const callId = h.db.addConfirmedCall({ ...CALL, confirmedAtMs: Date.now() - CONFIRM_MAX_AGE_MS + 5_000 });
        await waitFor(() => h.dialer.placed.length === 1, 3_000, 'placed');
        assert.equal(h.db.calls.get(callId)?.status, 'dialing');
    });

    it('refuses a call when the time of its CONFIRM is not known', async () => {
        const h = start(harness());
        const callId = h.db.addConfirmedCall({ ...CALL, confirmedAtMs: null });
        await waitFor(() => h.db.calls.get(callId)?.status === 'refused', 3_000, 'refused');
        assert.equal(h.db.calls.get(callId)?.reasonCode, 'confirm_time_unknown');
        assert.equal(h.db.calls.get(callId)?.reason, UNCHECKED_SAY);
        assert.equal(h.dialer.placed.length, 0);
    });

    it('refuses a call when the module\'s clock runs ahead of this one by more than the allowed skew', async () => {
        const h = start(harness());
        const callId = h.db.addConfirmedCall({ ...CALL, confirmedAtMs: Date.now() + CLOCK_SKEW_MS + 10_000 });
        await waitFor(() => h.db.calls.get(callId)?.status === 'refused', 3_000, 'refused');
        assert.equal(h.db.calls.get(callId)?.reasonCode, 'confirm_time_unknown');
        assert.equal(h.dialer.placed.length, 0);
    });

    it('measures the dial deadline against the Dialer\'s own window, read from its source', () => {
        const source = readFileSync(new URL('../../cartesia/src/call.ts', import.meta.url), 'utf8');
        const windowMs = Number(/this\.maxConfirmToDialMs = config\.maxConfirmToDialMs \?\? ([\d_]+);/.exec(source)?.[1]?.replace(/_/g, ''));
        assert.equal(CONFIRM_TO_DIAL_MS, windowMs, 'the deadline is the Dialer\'s window');
        assert.ok(CONFIRM_MAX_AGE_MS + CLOCK_SKEW_MS < CONFIRM_TO_DIAL_MS, 'a call placed at the age limit still has time to dial');
    });

    it('cancels a placed call that has not dialed by the deadline after the CONFIRM, and says why', async () => {
        const h = start(harness({ confirmToDialMs: 200, clockSkewMs: 0 }));
        const callId = h.db.addConfirmedCall(CALL);
        await waitFor(() => h.dialer.placed.length === 1, 3_000, 'placed');
        // The Dialer is still checking (no call id yet) when the deadline passes.
        await waitFor(() => h.dialer.cancels.length === 1, 2_000, 'cancelled at the deadline');
        assert.deepEqual(h.dialer.cancels, ['operator']);
        h.dialer.handle?.finish({ result: 'cancelled', dialed: false, cancelReason: 'operator' });
        await waitFor(() => h.db.calls.get(callId)?.status === 'refused', 3_000, 'refused');
        assert.equal(h.db.calls.get(callId)?.reasonCode, 'confirm_expired');
        assert.equal(h.db.calls.get(callId)?.reason, EXPIRED_SAY);
    });

    it('keeps the Dialer\'s hold sentence when a late call is cancelled with the contact on hold', () => {
        const base = { requestId: 'r', result: 'cancelled' as const, dialed: false as const, callId: null, endReason: null, cancelReason: 'operator' as const, refusal: null, optedOut: false, summary: null, ms: 1 };
        assert.equal(lateReason({ ...base, held: false, spoken: 'The call was cancelled.' }), EXPIRED_SAY);
        const held = lateReason({ ...base, held: true, spoken: 'The call was cancelled. Calls to Leon are on hold until someone checks.' });
        assert.ok(held.startsWith(EXPIRED_SAY) && held.endsWith('Calls to Leon are on hold until someone checks.'), held);
    });

    it('leaves a call alone once it has dialed, whatever the deadline', async () => {
        const h = start(harness({ confirmToDialMs: 200, clockSkewMs: 0 }));
        h.db.addConfirmedCall(CALL);
        await waitFor(() => h.dialer.placed.length === 1, 3_000, 'placed');
        h.callRunner.onSnapshot(snapshot('call-test-1', 'ringing'));
        await settle(350);
        assert.deepEqual(h.dialer.cancels, []);
    });

    /** A harness whose clock moves `ms` while each claim is out. */
    function slowClaim(ms: number): Harness {
        let t = 1_000;
        const h = start(harness({ clock: () => t }));
        const realCall = h.db.call.bind(h.db);
        h.db.call = (async (name: string, args: unknown) => {
            if (name === 'claimCall') t += ms;
            await realCall(name as never, args as never);
        }) as typeof h.db.call;
        return h;
    }

    it('refuses instead of dialing when the claim took longer than the window', async () => {
        const h = slowClaim(CONFIRM_TO_PLACE_MS + 1_000);
        const callId = h.db.addConfirmedCall(CALL);
        await waitFor(() => h.db.calls.get(callId)?.status === 'refused', 3_000, 'refused');
        assert.equal(h.db.calls.get(callId)?.reasonCode, 'confirm_expired');
        assert.equal(h.dialer.placed.length, 0);
    });

    it('dials when the claim came back inside the window', async () => {
        const h = slowClaim(CONFIRM_TO_PLACE_MS - 1_000);
        const callId = h.db.addConfirmedCall(CALL);
        await waitFor(() => h.dialer.placed.length === 1, 3_000, 'placed');
        assert.equal(h.db.calls.get(callId)?.status, 'dialing');
    });

    it('tries a claim again when it never reached the module, and dials once', async () => {
        const h = start(harness());
        // Three tries in one round, every one failing before it was sent.
        h.db.failNext('claimCall', 'disconnected', { times: 3 });
        const callId = h.db.addConfirmedCall(CALL);
        await waitFor(() => h.dialer.placed.length === 1, 3_000, 'placed after another look');
        assert.equal(h.db.attempted.filter((a) => a.name === 'claimCall').length, 4);
        assert.equal(h.db.calls.get(callId)?.status, 'dialing');
        await settle(40);
        assert.equal(h.dialer.placed.length, 1, 'one CONFIRM, one call');
    });

    it('stops trying after MAX_CLAIM_TRIES rounds that never reached the module', async () => {
        const h = start(harness());
        h.db.failNext('claimCall', 'disconnected', { times: 3 * MAX_CLAIM_TRIES + 3 });
        h.db.addConfirmedCall(CALL);
        const claims = () => h.db.attempted.filter((a) => a.name === 'claimCall').length;
        await waitFor(() => claims() === 3 * MAX_CLAIM_TRIES, 3_000, 'every round');
        await settle(60);
        assert.equal(claims(), 3 * MAX_CLAIM_TRIES);
        assert.equal(h.dialer.placed.length, 0);
    });

    it('waits for the line when another call is live, and tries the claim again when the views change', async () => {
        const h = start(harness());
        h.db.failNext('claimCall', 'refused', { message: 'line busy' });
        h.db.addConfirmedCall(CALL);
        await waitFor(() => h.db.attempted.some((a) => a.name === 'claimCall'), 3_000, 'claimed');
        await settle(40);
        assert.equal(h.db.attempted.filter((a) => a.name === 'claimCall').length, 1, 'no timer retries while the line is busy');
        // The live call ends: the views change.
        h.db.addOptionsJob({ questionText: 'Are you warm enough?' });
        await waitFor(() => h.dialer.placed.length === 1, 3_000, 'placed once the line was free');
        assert.equal(h.db.attempted.filter((a) => a.name === 'claimCall').length, 2);
    });

    it('does not place a call when the connection drops after the claim, and says why once it is back', async () => {
        const h = start(harness());
        const realCall = h.db.call.bind(h.db);
        h.db.call = (async (name: string, args: unknown) => {
            await realCall(name as never, args as never);
            if (name === 'claimCall') {
                // The views go stale: a STOP or a revocation now would not reach the sidecar.
                h.db.setConnected(false);
                setTimeout(() => h.db.setConnected(true), 50);
            }
        }) as typeof h.db.call;
        const callId = h.db.addConfirmedCall(CALL);
        await waitFor(() => h.db.calls.get(callId)?.status === 'refused', 3_000, 'refused once connected again');
        assert.equal(h.dialer.placed.length, 0);
        assert.equal(h.db.calls.get(callId)?.reasonCode, 'disconnected');
        assert.equal(h.db.calls.get(callId)?.reason, OFFLINE_SAY);
    });

    it('looks again at once when the views changed while a line busy claim was out', async () => {
        const h = start(harness());
        h.db.failNext('claimCall', 'refused', { message: 'line busy' });
        const realCall = h.db.call.bind(h.db);
        let first = true;
        h.db.call = (async (name: string, args: unknown) => {
            if (name === 'claimCall' && first) {
                first = false;
                // The live call ends while this claim is out: one change to the views, and no other after it.
                h.db.addConfirmedErrand({ formKey: 'care_team_request', formUrl: 'demo', formTitle: 'Care team request', fieldsJson: '[]', digest: '0123456789abcdef' });
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
            await realCall(name as never, args as never);
        }) as typeof h.db.call;
        h.db.addConfirmedCall(CALL);
        await waitFor(() => h.dialer.placed.length === 1, 1_000, 'placed without waiting for another change');
    });

    it('never tries a refused claim again, even after a reconnect', async () => {
        const h = start(harness());
        h.db.failNext('claimCall', 'refused');
        const callId = h.db.addConfirmedCall(CALL);
        await waitFor(() => h.db.attempted.some((a) => a.name === 'claimCall'), 3_000, 'claimed');
        await settle(30);
        h.db.setConnected(false);
        h.db.setConnected(true);
        await settle(60);
        assert.equal(h.db.attempted.filter((a) => a.name === 'claimCall').length, 1);
        assert.equal(h.db.calls.get(callId)?.status, 'confirmed');
        assert.equal(h.dialer.placed.length, 0);
    });

    it('carries a hold through to the report, with the Dialer\'s sentence and a code for it', () => {
        const held = ' Calls to Leon are on hold until someone checks.';
        const base = { requestId: 'r', dialed: true as const, callId: null, endReason: null, cancelReason: null, refusal: null, optedOut: false, held: true, summary: null, ms: 1 };
        const optedOut = finalReport({ ...base, result: 'answered', optedOut: true, spoken: `The call has ended.${held}` });
        assert.deepEqual([optedOut.status, optedOut.reasonCode, optedOut.reason], ['ended', 'opt_out_hold', `The call has ended.${held}`]);
        assert.equal(finalReport({ ...base, result: 'answered', spoken: `The call has ended.${held}` }).reasonCode, 'hold_file_error');
        const refused = finalReport({ ...base, result: 'refused', refusal: { code: 'hold_file_error', reason: 'I could not record the call safely, so I did not call.' }, spoken: `I could not record the call safely, so I did not call.${held}` });
        assert.ok(refused.reason.endsWith(held.trim()), 'a held refusal keeps the hold sentence');
        assert.ok(finalReport({ ...base, result: 'unknown', spoken: `I could not tell how the call ended.${held}` }).reason.endsWith(held.trim()));
        assert.equal(finalReport({ ...base, held: false, result: 'answered', spoken: 'The call has ended.' }).reason, '', 'no hold, nothing extra');
    });

    it('reports a call that ended on hold, and logs that it is held without the name', async () => {
        const h = start(harness());
        h.db.addConfirmedCall(CALL);
        await waitFor(() => h.dialer.placed.length === 1, 3_000, 'placed');
        h.dialer.handle?.finish({ result: 'answered', optedOut: true, held: true, spoken: `The call has ended. Calls to ${SECRET.contactName} are on hold until someone checks.` });
        await waitFor(() => h.db.applied.some((a) => a.name === 'reportCallStatus' && (a.args as { status: string }).status === 'ended'), 3_000, 'reported');
        const report = h.db.applied.find((a) => a.name === 'reportCallStatus' && (a.args as { status: string }).status === 'ended')?.args as { reasonCode: string; reason: string };
        assert.equal(report.reasonCode, 'opt_out_hold');
        assert.match(report.reason, /on hold until someone checks/);
        assert.ok(h.log.entries.some((e) => e.message === 'call finished' && e.fields.held === true));
        assert.ok(!h.log.text().toLowerCase().includes(SECRET.contactName.toLowerCase()), 'the name stays out of the log');
    });

    it('maps outcomes to the module\'s statuses, an unclear dial as failed with result unknown', () => {
        const base = { requestId: 'r', dialed: true as const, callId: null, endReason: null, cancelReason: null, refusal: null, optedOut: false, held: false, spoken: 'I could not tell.', summary: null, ms: 1 };
        assert.deepEqual(finalReport({ ...base, result: 'no_answer' }), { status: 'ended', result: 'no_answer', endReason: '', reasonCode: '', reason: '' });
        assert.equal(finalReport({ ...base, result: 'unknown', dialed: 'unknown' }).reasonCode, 'dial_unknown');
        assert.equal(finalReport({ ...base, result: 'unknown' }).status, 'failed');
        assert.equal(cancelReasonOf('auto_pause'), 'auto_pause');
        assert.equal(cancelReasonOf('something else'), 'operator');
        assert.equal(lineRole('user'), 'recipient');
        assert.equal(lineRole('assistant'), 'assistant');
        assert.ok(!finalReport({ ...base, result: 'refused', refusal: { code: 'do_not_call', reason: 'No.' } }).reason.includes(SECRET.phone));
    });
});
