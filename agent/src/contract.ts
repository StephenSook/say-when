// Every SpacetimeDB name the sidecar depends on, in one place. The adapter builds its calls and reads from these
// lists, and test/contract.test.ts checks them against docs/spacetime.md (and against the generated bindings and
// the module source once those exist), so a rename fails a test instead of failing at the venue.
//
// Wire names are snake_case (docs/spacetime.md 2.1). Generated TypeScript bindings use camelCase accessors and
// camelCase argument keys, which `camel()` derives from the wire names.

import type { ReducerName } from './types.js';

/** snake_case to camelCase, the 2.13 case policy: `agent_publish_options` to `agentPublishOptions`. */
export function camel(wire: string): string {
    return wire.replace(/_([a-z0-9])/g, (_match, ch: string) => ch.toUpperCase());
}

export interface ReducerSpec {
    /** The reducer's wire name. */
    wire: string;
    /** Argument names in order, as docs/spacetime.md lists them. */
    args: readonly string[];
}

/** The reducers the sidecar calls (docs/spacetime.md 3.2, 3.6, 3.7). Literal types, so typecheck/bindings.check.ts can compare them. */
export const REDUCERS = {
    agentClaim: { wire: 'agent_claim', args: ['job_id'] },
    agentProgress: {
        wire: 'agent_progress',
        args: ['job_id', 'attempt', 'event_key', 'stage', 'status', 'detail', 'ms', 'counts_json', 'payload_json'],
    },
    agentPublishOptions: { wire: 'agent_publish_options', args: ['job_id', 'attempt', 'answer_mode', 'options', 'final'] },
    agentAttachPreview: {
        wire: 'agent_attach_preview',
        args: [
            'job_id',
            'attempt',
            'status',
            'form_title',
            'read_back_text',
            'read_back_json',
            'preview_digest',
            'screenshot_url',
            'reason_code',
            'reason',
            'preview_ms',
        ],
    },
    agentFail: { wire: 'agent_fail', args: ['job_id', 'attempt', 'reason_code', 'reason'] },
    agentDone: { wire: 'agent_done', args: ['job_id', 'attempt', 'counts_json'] },
    claimErrand: { wire: 'claim_errand', args: ['errand_id', 'digest'] },
    completeErrand: {
        wire: 'complete_errand',
        args: ['errand_id', 'attempt', 'status', 'confirmation_text', 'screenshot_url', 'reason_code', 'reason', 'submit_ms'],
    },
    claimCall: { wire: 'claim_call', args: ['call_id', 'digest'] },
    reportCallStatus: {
        wire: 'report_call_status',
        args: ['call_id', 'attempt', 'status', 'result', 'end_reason', 'reason_code', 'reason'],
    },
    addCallLine: { wire: 'add_call_line', args: ['call_id', 'attempt', 'line_key', 'role', 'text'] },
    requestPairing: { wire: 'request_pairing', args: ['code', 'role', 'label'] },
} as const satisfies { readonly [K in ReducerName]: ReducerSpec };

/** snake_case to camelCase at the type level, matching `camel()`. */
export type Camel<S extends string> = S extends `${infer Head}_${infer Tail}` ? `${Head}${Capitalize<Camel<Tail>>}` : S;

export interface ViewSpec {
    wire: string;
    /** The row fields the sidecar reads. */
    fields: readonly string[];
}

/** The per-identity views the sidecar subscribes to (docs/spacetime.md section 5). */
export const VIEWS = {
    agentQueue: {
        wire: 'agent_queue',
        fields: [
            'job_id',
            'kind',
            'status',
            'attempt',
            'claimed_by_me',
            'question_id',
            'question_text',
            'origin',
            'menu_item',
            'asked_by',
            'web_search_allowed',
            'memory_allowed',
            'errand_id',
            'form_key',
            'form_url',
            'form_title',
            'fields_json',
            'reply_text',
            'recent_errand_title',
            'recent_errand_sent_at',
            'created_at',
        ],
    },
    errandQueue: {
        wire: 'errand_queue',
        fields: ['errand_id', 'status', 'claim_attempt', 'claimed_by_me', 'form_key', 'form_url', 'fields_json', 'confirmed_digest', 'confirmed_at'],
    },
    callQueue: {
        wire: 'call_queue',
        fields: ['call_id', 'status', 'claim_attempt', 'claimed_by_me', 'request_id', 'contact_id', 'script_digest', 'cancel_requested', 'cancel_reason'],
    },
} as const satisfies Record<string, ViewSpec>;

export type ViewName = keyof typeof VIEWS;

/** A public table the sidecar reads to tell whether it is paired (docs/spacetime.md 2.9). */
export const DEVICE_STATUS = { wire: 'device_status', fields: ['identity', 'role'] } as const;

/**
 * The public call board (docs/spacetime.md section 5), read for one thing: when the person confirmed a call, by the
 * module's clock. `call_queue` does not carry that time, and a call must not follow its CONFIRM by long (src/calls.ts).
 */
export const BOARD_CALLS = { wire: 'board_calls', fields: ['call_id', 'confirmed_at'] } as const;

/** Vocabulary the module checks (docs/spacetime.md 2.9 and spacetime/src/util.ts). */
export const DETAIL_PATTERN = /^[a-z0-9 :_-]{1,120}$/;
export const EVENT_KEY_PATTERN = /^[A-Za-z0-9:_.-]{1,128}$/;
export const LINE_KEY_PATTERN = /^[A-Za-z0-9:_.-]{1,128}$/;
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const DIGEST_PATTERN = /^[0-9a-f]{16}$/;
export const STAGES = ['listen', 'search', 'retrieve', 'plan', 'speak', 'select', 'errand', 'call'] as const;
export const STATUSES = ['started', 'ok', 'error'] as const;

/** Limits the module enforces, so the sidecar fails early with a clear error instead of a refused reducer. */
export const LIMITS = {
    optionText: 200,
    maxOptions: 4,
    countsJsonChars: 2048,
    countsKeyChars: 40,
    /** `payload_json` is at most 16 KB; this leaves room for multibyte characters. */
    payloadBytes: 16_000,
    readBackJsonChars: 16_384,
    readBackText: 2000,
    confirmationText: 2000,
    screenshotUrl: 1000,
    formTitle: 120,
    reasonCode: 40,
    reason: 300,
    endReason: 60,
    callLineText: 500,
    actionFields: 30,
    formUrl: 500,
} as const;
