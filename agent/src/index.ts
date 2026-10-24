// Public surface of @say-when/agent, the Eleven agent sidecar. `npm start` runs src/main.ts; these exports
// are for tests and for anyone embedding the pieces.

export {
    CallRunner,
    cancelReasonOf,
    CANCELLED_SAY,
    CLOCK_SKEW_MS,
    CONFIRM_MAX_AGE_MS,
    CONFIRM_TO_DIAL_MS,
    CONFIRM_TO_PLACE_MS,
    EXPIRED_SAY,
    finalReport,
    lineRole,
    OFFLINE_SAY,
    UNCHECKED_SAY,
    type CallRunnerDeps,
} from './calls.js';
export { DEFAULTS, loadEnvFiles, readConfig, type AgentConfig, type ConfigResult, type EnvCheck } from './config.js';
export { CALL_CLAIM_MS, camel, DETAIL_PATTERN, LIMITS, MODULE_EVENT_KEY, REDUCERS, VIEWS, type ReducerSpec, type ViewSpec } from './contract.js';
export { DbCallError, toDbError, type AgentDb, type DbErrorKind } from './db/db.js';
export { MemoryDb, type CallRecord, type ErrandRecord, type PipelineRecord, type PublishRecord } from './db/memory-db.js';
export { callReducer, MAX_CLAIM_TRIES, neverSent, type CallOutcome, type RetryOptions, type Verified } from './db/retry.js';
export { DeadlineError, withDeadline } from './deadline.js';
export {
    ContractError,
    SpacetimeAgentDb,
    toAgentConsent,
    toAgentQueueRow,
    toCallQueueRow,
    toErrandQueueRow,
    TokenSaveError,
    type BuilderLike,
    type ConnectionLike,
    type SpacetimeOptions,
} from './db/spacetime-db.js';
export { ErrandRunner, fromSubmitError, fromSubmitResult, type ErrandRunnerDeps } from './errands.js';
export { FormsFileError, loadForms, parseForms } from './forms.js';
export { ConversationLog, parseFields, PreviewBook, runOptionsJob, runPreviewJob, runRememberJob, type JobDeps, type PreviewRecord } from './jobs.js';
export { consoleLogger, recordingLogger, silentLogger, type Logger, type RecordingLogger } from './log.js';
export { applyOrder, buildOptions, looksYesNo, memoryFirstOptions } from './options.js';
export { Orchestrator, failureOf, type OrchestratorOptions } from './orchestrator.js';
export { countsJson, JobEvents, label, payloadJson, StaleAttemptError, Step } from './pipeline.js';
export { ClaudePlanner, DEFAULT_PLANNER_MODEL, FALLBACK_MODELS, errorCode, type ClaudePlannerOptions, type Effort, type MessagesApi } from './planner/claude.js';
export { buildUserMessage, SYSTEM_PROMPT } from './planner/prompt.js';
export { PlanReplySchema, type PlanReply } from './planner/schema.js';
export { PlannerError, type Plan, type PlanInput, type PlannedOption, type PlannerPort, type PlanResult } from './planner/types.js';
export { validatePlan } from './planner/validate.js';
export type { Classifier, DialerPort, ErrandPort, MemoryPort, SearchPort, WebIndexPort } from './ports.js';
export { excerpt, memoryHitPayload, searchRowPayload, sourceRefOf, webHitPayload } from './privacy.js';
export { JobAbortedError, placeQuery, recallMemory, retrieveStep, searchStep, type RetrievalDeps } from './retrieval.js';
export { errorTag, hasShowableMessage, startupFailureLine, StartupError } from './startup.js';
export * from './types.js';
