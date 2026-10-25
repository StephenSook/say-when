// The option planner on Claude (PLAN row 3.4), through the Anthropic TypeScript SDK.
//
// - Model: claude-haiku-5-5 by default, the current fast model for latency-sensitive work, since the person is
//   waiting with the headset on. AGENT_PLANNER_MODEL overrides it, for example claude-opus-5-5.
// - Thinking is left at the model default (adaptive); `output_config.effort` sets the depth, default `low`.
//   No temperature or other sampling parameters: current models refuse non-default values.
// - Output: structured output (`output_config.format`) from the zod schema in schema.ts. The request goes through
//   `messages.create`, not `messages.parse`, so the stop reason is read before the reply text: a refusal or a
//   cut-off reply becomes its own clear error instead of a parse failure. The reply is then parsed with the same
//   zod schema and checked by validate.ts.
// - Retries: the SDK's own retries are off. One attempt, plus at most one retry on a transient error (timeout,
//   network, 429 with a short Retry-After, 5xx, 529 overloaded). Everything else fails at once.
// - Invalid replies (PLAN D27): repair.ts first mends what it can without a model call. A reply still invalid is
//   logged by rule name and sent back once, with the broken rules named in the message. The two retries share one
//   budget of two calls, so a planner call never takes longer than it did before.
// - Refusal fallback: for models that support it (Opus 5.5, Opus 5, Fable 5.1, Sonnet 5.5) the request opts into
//   the server-side fallback (`fallbacks: "default"`, beta server-side-fallback-2026-07-01). Haiku 5.5 has no
//   server-side fallback, so its requests do not send the parameter; a refusal there is a PlannerError.

import Anthropic from '@anthropic-ai/sdk';

import { silentLogger, type Logger } from '../log.js';
import { buildUserMessage, retryNote, SYSTEM_PROMPT } from './prompt.js';
import { repairReply } from './repair.js';
import { planReplyFormat, type PlanReply } from './schema.js';
import { allowedInput, PlannerError, TRANSIENT_CODES, type PlanInput, type PlannerErrorCode, type PlannerPort, type PlanResult } from './types.js';
import { validatePlan } from './validate.js';

/** Calls per plan, every retry included: the transient retry and the invalid-reply retry share them. */
const MAX_CALLS = 2;

export const DEFAULT_PLANNER_MODEL = 'claude-haiku-5-5';
export const DEFAULT_PLANNER_EFFORT = 'low';
export const DEFAULT_PLANNER_TIMEOUT_MS = 15_000;

/** Models that accept the server-side refusal fallback in its `default` form. */
export const FALLBACK_MODELS: ReadonlySet<string> = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5-5']);
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export type Effort = 'low' | 'medium' | 'high';
type CreateParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
type CreateOptions = { timeout?: number; maxRetries?: number; signal?: AbortSignal };

/** The one SDK call the planner makes, so tests can stand in for the API. */
export interface MessagesApi {
    create(params: CreateParams, options?: CreateOptions): PromiseLike<Anthropic.Beta.BetaMessage>;
}

export interface ClaudePlannerOptions {
    /** Defaults to `new Anthropic({ maxRetries: 0 }).beta.messages`, which reads ANTHROPIC_API_KEY. */
    api?: MessagesApi;
    model?: string;
    effort?: Effort;
    /** Per attempt. */
    timeoutMs?: number;
    /** Room for adaptive thinking plus the reply; the reply itself is a few hundred tokens. */
    maxTokens?: number;
    /** Wait before the one retry. */
    retryDelayMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    /** Repairs and invalid replies, by rule name only. */
    log?: Logger;
}

export class ClaudePlanner implements PlannerPort {
    readonly model: string;
    private readonly api: MessagesApi;
    private readonly effort: Effort;
    private readonly timeoutMs: number;
    private readonly maxTokens: number;
    private readonly retryDelayMs: number;
    private readonly sleep: (ms: number) => Promise<void>;
    private readonly now: () => number;
    private readonly log: Logger;

    constructor(options: ClaudePlannerOptions = {}) {
        this.api = options.api ?? new Anthropic({ maxRetries: 0 }).beta.messages;
        this.model = options.model ?? DEFAULT_PLANNER_MODEL;
        this.effort = options.effort ?? DEFAULT_PLANNER_EFFORT;
        this.timeoutMs = options.timeoutMs ?? DEFAULT_PLANNER_TIMEOUT_MS;
        this.maxTokens = options.maxTokens ?? 8000;
        this.retryDelayMs = options.retryDelayMs ?? 400;
        this.sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
        this.now = options.now ?? (() => performance.now());
        this.log = options.log ?? silentLogger;
    }

    /** The request for one planner call; `broken` names the rules the last reply broke, for the retry. Exposed for tests. */
    request(input: PlanInput, broken: readonly string[] = []): CreateParams {
        const message = buildUserMessage(input);
        const params: CreateParams = {
            model: this.model,
            max_tokens: this.maxTokens,
            system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
            messages: [{ role: 'user', content: broken.length > 0 ? `${message}\n\n${retryNote(broken, input)}` : message }],
            output_config: { effort: this.effort, format: planReplyFormat },
        };
        if (FALLBACK_MODELS.has(this.model)) {
            params.betas = [FALLBACK_BETA];
            params.fallbacks = 'default';
        }
        return params;
    }

    async plan(input: PlanInput, signal: AbortSignal): Promise<PlanResult> {
        const started = this.now();
        let attempts = 0;
        // The last invalid reply's error, once the one retry for it is under way.
        let invalid: PlannerError | null = null;
        for (;;) {
            let sent = input;
            let message: Anthropic.Beta.BetaMessage | null = null;
            while (message === null) {
                attempts += 1;
                // Consent is read again for every attempt, the retry included, right before the request leaves.
                sent = allowedInput(input);
                try {
                    message = await this.api.create(this.request(sent, invalid?.problems), { timeout: this.timeoutMs, maxRetries: 0, signal });
                } catch (error) {
                    const code = errorCode(error);
                    if (invalid) {
                        // The retry for an invalid reply failed too: the job fails on the reply, as it did before.
                        if (signal.aborted || code === 'aborted') throw new PlannerError('aborted');
                        this.log.warn('planner retry failed', { code, attempt: attempts });
                        throw invalid;
                    }
                    const wait = retryWait(error, this.retryDelayMs);
                    if (attempts >= MAX_CALLS || !TRANSIENT_CODES.has(code) || wait === null || signal.aborted) throw new PlannerError(code);
                    await this.sleep(wait);
                    if (signal.aborted) throw new PlannerError('aborted');
                }
            }
            try {
                return this.result(message, sent, started, attempts);
            } catch (error) {
                if (!(error instanceof PlannerError) || error.code !== 'invalid_reply') throw error;
                // Rule names only, never the reply's words.
                this.log.warn('planner reply invalid', { problems: error.problems.join(','), attempt: attempts });
                if (invalid || attempts >= MAX_CALLS || signal.aborted) throw error;
                invalid = error;
            }
        }
    }

    /** One reply read, repaired and validated against what was sent. Throws PlannerError. */
    private result(message: Anthropic.Beta.BetaMessage, sent: PlanInput, started: number, attempts: number): PlanResult {
        // Read the stop reason before the content: a refusal or a cut-off reply does not match the schema.
        if (message.stop_reason === 'refusal') throw new PlannerError('refused');
        if (message.stop_reason === 'max_tokens' || message.stop_reason === 'model_context_window_exceeded') throw new PlannerError('truncated');
        const text = message.content
            .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === 'text')
            .map((block) => block.text)
            .join('');
        if (text.trim() === '') throw new PlannerError('invalid_reply', ['empty_reply']);
        let reply: PlanReply;
        try {
            reply = planReplyFormat.parse(text);
        } catch {
            // The SDK's parse error can quote the reply, so only its kind is kept.
            throw new PlannerError('invalid_reply', ['schema']);
        }
        // Mended where the code can, then checked against what was sent: an option may cite only what the planner was shown.
        const repaired = repairReply(reply, sent);
        if (repaired.fixes.length > 0) this.log.info('planner reply repaired', { fixes: repaired.fixes.join(','), attempt: attempts });
        const plan = validatePlan(repaired.reply, sent, repaired.short ? { minPick: 1 } : {});
        const usage = message.usage;
        return {
            ...plan,
            model: message.model,
            ms: Math.max(0, Math.round(this.now() - started)),
            attempts,
            inputTokens: usage.input_tokens,
            outputTokens: usage.output_tokens,
            cacheReadTokens: usage.cache_read_input_tokens ?? 0,
            fallbackUsed: (usage.iterations ?? []).some((entry) => entry.type === 'fallback_message'),
            sentMemory: sent.memory.length > 0 || sent.history.length > 0,
            sentWeb: sent.web.length > 0,
        };
    }
}

/** The SDK's typed errors, most specific first (shared/error-codes.md in the claude-api skill). */
export function errorCode(error: unknown): PlannerErrorCode {
    if (error instanceof PlannerError) return error.code;
    if (error instanceof Anthropic.APIUserAbortError) return 'aborted';
    if (error instanceof Anthropic.APIConnectionTimeoutError) return 'timeout';
    if (error instanceof Anthropic.APIConnectionError) return 'network';
    if (error instanceof Anthropic.RateLimitError) return 'rate_limited';
    if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) return 'auth';
    if (error instanceof Anthropic.NotFoundError) return 'not_found';
    if (error instanceof Anthropic.BadRequestError || error instanceof Anthropic.UnprocessableEntityError) return 'bad_request';
    if (error instanceof Anthropic.InternalServerError) return error.status === 529 ? 'overloaded' : 'unavailable';
    if (error instanceof Anthropic.APIError) {
        if (error.status === 408 || error.status === 409) return 'unavailable';
        return 'error';
    }
    return 'error';
}

/** How long to wait before the retry, or null when the server asked for longer than the person should wait. */
function retryWait(error: unknown, base: number): number | null {
    if (error instanceof Anthropic.RateLimitError) {
        const header = error.headers?.get('retry-after');
        const seconds = header ? Number(header) : NaN;
        if (Number.isFinite(seconds)) return seconds <= 2 ? Math.max(base, seconds * 1000) : null;
    }
    return base;
}
