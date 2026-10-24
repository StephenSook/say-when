// @say-when/telemetry: content-free switch telemetry from SpacetimeDB into Tiger Data. See README.md.
export { connectTiger, poolConfig, type ConnectOptions, type TigerConnection } from './db.js';
export { CredentialError, DEFAULT_SERVICE_ID, loadTarget, parseConnectionString, redact, safeMessage, TIGER_READ_ONLY_OPTION, type PgTarget } from './credentials.js';
export { loadPin, pinnedSsl, TlsPinError, type LoadedPin, type PinFile } from './tls.js';
export { migrate, verifySchema, readMigrations, splitStatements, type MigrateReport, type VerifyReport } from './migrate.js';
export { getStats, fetchRawStats, summarize, percentileCont, type DashboardStats, type RawStats, type StatsOptions } from './stats.js';
export { createPipeline, type Pipeline, type PipelineOptions } from './pipeline.js';
export { Tracker, restMasks, minuteStart, type RestState, type TrackerCounters } from './tracker.js';
export { TelemetryWriter, type WriterOptions, type WriterStats, type Timers } from './writer.js';
export { PgSink, buildInsert, microsToIso, backlogRange, refreshAggregate, type RowSink } from './sink.js';
export { FakeSource, type FakeEvent } from './sources/fake.js';
export { SpacetimeSource, SUBSCRIBED, type BuilderLike, type ConnectionLike, type SpacetimeSourceOptions } from './sources/spacetime.js';
export type { SourceHandlers, TelemetrySource } from './sources/source.js';
export { consoleLogger, silentLogger, type Logger } from './log.js';
export * from './types.js';
