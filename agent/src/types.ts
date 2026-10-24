// Domain types the sidecar works with. They mirror docs/spacetime.md: the wire vocabulary in 2.2 and 2.9, the
// agent views in section 5, and the reducer arguments in 3.6 and 3.7. Ids are bigint (u64), attempts and
// durations are number (u32), enum values are lowercase snake case strings.

import { TONES, type Tone } from '@say-when/cartesia';

export { TONES, type Tone };

/**
 * `pipeline_event.stage`. The sidecar writes search, retrieve, plan and errand; the module and the station write the
 * rest. Each read the person hears is one `speak` step the module writes itself (module v2), so the sidecar writes
 * none: it is never the writer of a speak, listen or select step.
 */
export type Stage = 'listen' | 'search' | 'retrieve' | 'plan' | 'speak' | 'select' | 'errand' | 'call';
export type StageStatus = 'started' | 'ok' | 'error';

export type JobKind = 'options' | 'errand_preview' | 'remember';
export type JobStatus = 'pending' | 'claimed' | 'done' | 'failed' | 'cancelled';
export type Origin = 'partner' | 'menu';
export type MenuItem = 'none' | 'need' | 'request' | 'call' | 'say';
export type AnswerMode = 'pick' | 'yes_no';
/** What the planner may offer. `menu` options are made by the module, never by the sidecar. */
export type OptionKind = 'reply' | 'errand' | 'call';
/** `stock`: the yes or no fast path's own Yes and No (src/fastpath.ts), written by no model. */
export type Provenance = 'memory' | 'web' | 'maps' | 'model' | 'stock';

export type ErrandStatus =
    | 'drafted'
    | 'previewed'
    | 'awaiting_confirm'
    | 'confirmed'
    | 'submitting'
    | 'submitted'
    | 'refused'
    | 'failed'
    | 'unknown_outcome'
    | 'stopped';

export type CallStatus =
    | 'prepared'
    | 'awaiting_confirm'
    | 'confirmed'
    | 'dialing'
    | 'ringing'
    | 'connected'
    | 'ended'
    | 'failed'
    | 'stopped'
    | 'refused';

/** The Option row's `sources` entry: `{ source, url?, place_id?, fetched_at }`. Optional columns are `undefined` when unset. */
export interface SourceRef {
    source: string;
    url: string | undefined;
    placeId: string | undefined;
    fetchedAt: string;
}

/** One option as `agent_publish_options` takes it (`OptionInput` in spacetime/src/schema.ts). */
export interface OptionInput {
    kind: OptionKind;
    /** 1 to 200 characters: what the person hears in the earpiece and may say. */
    text: string;
    /** One of the Cartesia tones, or empty. */
    tone: Tone | '';
    laugh: boolean;
    provenance: Provenance;
    /** Web and place sources only. Memory is referenced by id in `memoryRefs`, never by text. */
    sources: SourceRef[];
    /** Moss memory ids behind the option. Content-free. */
    memoryRefs: string[];
    /** Errand: `{ formKey, formUrl, formTitle, fields }`. Call: the Dialer's PreparedCall. Empty for replies. */
    actionJson: string;
}

/** One row of the `agent_queue` view: Pending jobs plus jobs Claimed by this sidecar, with what each job needs. */
export interface AgentQueueRow {
    jobId: bigint;
    kind: JobKind;
    status: JobStatus;
    attempt: number;
    claimedByMe: boolean;
    questionId: bigint;
    /** Private: the partner's words, or the menu item. */
    questionText: string;
    origin: Origin;
    menuItem: MenuItem;
    /** Hex identity of whoever asked: the Moss partner id. */
    askedBy: string;
    webSearchAllowed: boolean;
    memoryAllowed: boolean;
    errandId: bigint;
    formKey: string;
    formUrl: string;
    formTitle: string;
    /** Private: the field values the errand option carries. */
    fieldsJson: string;
    /** Private: the reply that was said aloud, for Remember jobs. */
    replyText: string;
    /** The newest Submitted errand of the last 10 minutes, which a call option needs. Empty when there is none. */
    recentErrandTitle: string;
    recentErrandSentAtMs: number | null;
    createdAtMs: number;
}

/** One row of the `errand_queue` view: Confirmed errands plus Submitting errands claimed by this sidecar. */
export interface ErrandQueueRow {
    errandId: bigint;
    status: ErrandStatus;
    claimAttempt: number;
    claimedByMe: boolean;
    formKey: string;
    formUrl: string;
    fieldsJson: string;
    confirmedDigest: string;
    confirmedAtMs: number | null;
}

/** One row of the `call_queue` view: Confirmed calls plus calls claimed by this sidecar. */
export interface CallQueueRow {
    callId: bigint;
    status: CallStatus;
    claimAttempt: number;
    claimedByMe: boolean;
    requestId: string;
    contactId: string;
    scriptDigest: string;
    cancelRequested: boolean;
    /** The Dialer's CancelReason (`stop`, `headset_off`, `auto_pause`, `operator`), or empty. */
    cancelReason: string;
    /** When the person confirmed the call, by the module's clock (ms since the epoch), or null when not known. */
    confirmedAtMs: number | null;
}

/** The `agent_consent` row (module v2): the consent the agent works under now. */
export interface AgentConsent {
    /** The active session, or 0n between sessions. */
    sessionId: bigint;
    memoryAllowed: boolean;
    webSearchAllowed: boolean;
}

/** Call results the module accepts (spacetime/src/consent.ts CALL_RESULTS, the Dialer's CallResult). */
export type CallResult = 'answered' | 'no_answer' | 'busy' | 'voicemail' | 'cancelled' | 'failed' | 'refused' | 'unknown';

/**
 * Arguments of every reducer the sidecar calls, as generated TypeScript bindings take them: one object with
 * camelCase keys. The wire order is in src/contract.ts.
 */
export interface ReducerArgs {
    agentClaim: { jobId: bigint };
    agentProgress: {
        jobId: bigint;
        attempt: number;
        eventKey: string;
        stage: Stage;
        status: StageStatus;
        detail: string;
        ms: number;
        countsJson: string;
        payloadJson: string;
    };
    agentPublishOptions: { jobId: bigint; attempt: number; answerMode: AnswerMode; options: OptionInput[]; final: boolean };
    agentAttachPreview: {
        jobId: bigint;
        attempt: number;
        status: 'previewed' | 'refused' | 'failed';
        formTitle: string;
        readBackText: string;
        readBackJson: string;
        previewDigest: string;
        screenshotUrl: string;
        reasonCode: string;
        reason: string;
        previewMs: number;
    };
    agentFail: { jobId: bigint; attempt: number; reasonCode: string; reason: string };
    agentDone: { jobId: bigint; attempt: number; countsJson: string };
    claimErrand: { errandId: bigint; digest: string };
    completeErrand: {
        errandId: bigint;
        attempt: number;
        status: 'submitted' | 'duplicate' | 'refused' | 'failed' | 'unknown';
        confirmationText: string;
        screenshotUrl: string;
        reasonCode: string;
        reason: string;
        submitMs: number;
    };
    claimCall: { callId: bigint; digest: string };
    reportCallStatus: {
        callId: bigint;
        attempt: number;
        status: 'ringing' | 'connected' | 'ended' | 'failed' | 'refused';
        result: CallResult | '';
        endReason: string;
        reasonCode: string;
        reason: string;
    };
    addCallLine: { callId: bigint; attempt: number; lineKey: string; role: 'assistant' | 'recipient'; text: string };
    requestPairing: { code: number; role: 'agent'; label: string };
}

export type ReducerName = keyof ReducerArgs;

/** An errand form the planner may offer (AGENT_FORMS_FILE). The form must also have Errand consent in the module. */
export interface AllowedForm {
    /** The consent subject, for example `care_team_request`: `^[A-Za-z0-9_-]{1,64}$`. */
    formKey: string;
    /** `demo` (the Actor's built-in form) or an https address. */
    formUrl: string;
    /** From the approved list; it is what the person hears ("Send a Care team request"). */
    formTitle: string;
    fields: FormField[];
}

export interface FormField {
    /** The question's visible label on the form. */
    label: string;
    /** For choice questions: the only values the planner may pick. */
    choices?: string[];
    required?: boolean;
    /** A value that is always the same (for example who the request is from). The planner never writes it. */
    fixedValue?: string;
    /** A short note for the planner, for example "what they need, in a few words". */
    hint?: string;
}

/** A contact the Dialer has consent for. Only the id and the spoken name; the number never leaves the Dialer. */
export interface CallContact {
    contactId: string;
    name: string;
}
