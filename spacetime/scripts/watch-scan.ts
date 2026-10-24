// Smoke watcher for a NeuroLingo database, built on the generated agent bindings (docs/spacetime.md 6.3, S4).
//
//   npm run smoke -- pair --code 482913       ask to pair this script's identity as an Agent; the owner approves
//   npm run smoke -- watch --seconds 60       print every scan_state change and how late each scheduled tick ran
//   npm run smoke -- watch --act-as-agent     also play a stand-in agent: claim Options jobs and publish made-up
//                                             options, attach a made-up preview to an errand, and claim and
//                                             complete a Confirmed errand. Nothing leaves the database: no search,
//                                             no model, no form. Refused unless the database name ends in -dev, so
//                                             a demo never gets made-up options
//
// A question whose text contains [yes_no] gets two yes or no options; one containing [errand] gets an errand option
// (form key smoke_form, which needs `grant_consent errand smoke_form ...`) and a reply; any other gets four replies.
//
// Environment: STDB_HOST (default https://maincloud.spacetimedb.com), STDB_DB (default say-when-dev),
// STDB_TOKEN_FILE (default ~/.config/say-when/stdb_token_smoke_agent). The token file has mode 0600 and the token
// is never printed. Runs with vite-node (it comes with vitest), so no build step and no extra dependency.
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DbConnection } from '../bindings/agent';
import type { AgentQueueItem, ErrandQueueItem, OptionInput, ScanState as Scan } from '../bindings/agent/types';

const HOST = process.env.STDB_HOST ?? 'https://maincloud.spacetimedb.com';
const DB = process.env.STDB_DB ?? 'say-when-dev';
const TOKEN_FILE = process.env.STDB_TOKEN_FILE ?? join(homedir(), '.config', 'say-when', 'stdb_token_smoke_agent');

const argv = process.argv.slice(2);
const mode = argv[0];
function option(name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}
const flag = (name: string) => argv.includes(name);

const started = performance.now();
const stamp = () => `+${((performance.now() - started) / 1000).toFixed(3)}s`;
const log = (...parts: unknown[]) => console.log(stamp(), ...parts);

function readToken(): string | undefined {
  if (!existsSync(TOKEN_FILE)) return undefined;
  const token = readFileSync(TOKEN_FILE, 'utf8').trim();
  return token === '' ? undefined : token;
}

function saveToken(token: string): void {
  if (readToken() === token) return;
  mkdirSync(dirname(TOKEN_FILE), { recursive: true });
  writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
  chmodSync(TOKEN_FILE, 0o600);
  log(`token saved to ${TOKEN_FILE} (mode 600)`);
}

function connect(onReady: (conn: DbConnection, identityHex: string) => void): DbConnection {
  return DbConnection.builder()
    .withUri(HOST)
    .withDatabaseName(DB)
    .withToken(readToken())
    .onConnect((conn, identity, token) => {
      saveToken(token);
      onReady(conn, identity.toHexString());
    })
    .onConnectError((_ctx, err) => {
      log('connect error:', err.message);
      process.exit(1);
    })
    .build();
}

const ms = (micros: bigint) => Number(micros) / 1000;

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function describe(values: number[]): string {
  if (values.length === 0) return 'no samples';
  const s = [...values].sort((a, b) => a - b);
  const p95 = s[Math.max(0, Math.ceil(0.95 * s.length) - 1)]!;
  return `n=${s.length} median=${median(s).toFixed(0)} ms p95=${p95.toFixed(0)} ms max=${s[s.length - 1]!.toFixed(0)} ms min=${s[0]!.toFixed(0)} ms`;
}

// ---------- pair ----------

function pair(): void {
  const code = Number(option('--code') ?? 100000 + Math.floor(Math.random() * 900000));
  const label = option('--label') ?? 'smoke agent';
  connect((conn, identityHex) => {
    log(`connected as ${identityHex}`);
    conn.reducers
      .requestPairing({ code, role: 'agent', label })
      .then(() => {
        log(`pairing code ${code} for role agent. The owner approves it with:`);
        log(`  spacetime call --no-config --server maincloud ${DB} approve_pairing ${code} false`);
      })
      .catch((err: unknown) => {
        log('request_pairing refused:', err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      })
      .finally(() => {
        conn.disconnect();
        setTimeout(() => process.exit(), 200);
      });
  });
}

// ---------- watch ----------

function watch(): void {
  const seconds = Number(option('--seconds') ?? 60);
  const scansWanted = Number(option('--scans') ?? 0); // 0: run for --seconds
  const actAsAgent = flag('--act-as-agent');
  if (actAsAgent && !DB.endsWith('-dev')) {
    console.error('--act-as-agent writes made-up options and previews, so it runs only on a database whose name ends in -dev');
    process.exit(2);
  }

  const lateness: number[] = []; // server: when a scheduled step ran, minus when it was planned to run
  const clientDrift: number[] = []; // this laptop: gap between two arrivals, minus the planned dwell
  const cues = new Map<string, number>();
  const claimed = new Set<bigint>(); // jobs this run claimed
  const submitted = new Set<bigint>(); // errands this run claimed and completed
  let lastArrival: number | undefined;
  let updates = 0;
  let tickSteps = 0;
  let scansEnded = 0;
  let finished = false;

  function finish(conn: DbConnection, why: string): void {
    if (finished) return;
    finished = true;
    log(`stopping: ${why}`);
    log(`scan_state updates seen: ${updates}; steps run by a scheduled tick: ${tickSteps}; scans ended: ${scansEnded}`);
    log(`tick lateness on the server (step_started_at minus the previous step_ends_at): ${describe(lateness)}`);
    log(`arrival drift on this laptop (gap between updates minus the planned dwell): ${describe(clientDrift)}`);
    log(`cues: ${[...cues].map(([k, n]) => `${k} x${n}`).join(', ') || 'none'}`);
    if (actAsAgent) log(`jobs claimed and answered: ${claimed.size}; errands claimed and completed: ${submitted.size}`);
    conn.disconnect();
    setTimeout(() => process.exit(), 200);
  }

  function line(row: Scan): string {
    const parts = [
      `phase=${row.phase.tag}`,
      `mode=${row.mode.tag}/${row.answerMode.tag}`,
      `cursor=${row.cursor}/${row.optionCount}`,
      `pass=${row.pass}/${row.maxPasses}`,
      `step=${row.stepSeq}`,
      `q=${row.questionId} v=${row.version}`,
      `dwell=${ms(row.stepEndsAt.microsSinceUnixEpoch - row.stepStartedAt.microsSinceUnixEpoch).toFixed(0)}ms`,
    ];
    if (row.outcome) parts.push(`outcome=${row.outcome.tag}`);
    if (row.pickedRank !== undefined) parts.push(`picked=${row.pickedRank}`);
    if (row.pauseReason) parts.push(`paused=${row.pauseReason.tag}`);
    return parts.join(' ');
  }

  function onScan(old: Scan | undefined, row: Scan, conn: DbConnection): void {
    updates += 1;
    const arrival = performance.now();
    let note = '';
    if (old && row.stepSeq > old.stepSeq) {
      // A step a scheduled `scan_tick` ran starts at or after the planned end of the step before it; a step something
      // else started (a pick, a publish, a pause) starts before it, or follows an Idle step with no planned end. The
      // event context does not name the reducer for other identities' transactions, so this timing is the test.
      const late = ms(row.stepStartedAt.microsSinceUnixEpoch - old.stepEndsAt.microsSinceUnixEpoch);
      const plannedDwell = ms(old.stepEndsAt.microsSinceUnixEpoch - old.stepStartedAt.microsSinceUnixEpoch);
      if (late >= 0 && plannedDwell > 0) {
        tickSteps += 1;
        lateness.push(late);
        note = ` [scan tick, ran ${late.toFixed(0)} ms after its planned time]`;
        if (lastArrival !== undefined) clientDrift.push(arrival - lastArrival - plannedDwell);
      } else {
        note = ' [not a scan tick]';
      }
    }
    lastArrival = arrival;
    log(`scan_state ${old ? 'update' : 'insert'}: ${line(row)}${note}`);
    const ended = old && old.phase.tag !== 'Idle' && old.phase.tag !== 'Paused' && row.phase.tag === 'Idle';
    if (ended) {
      scansEnded += 1;
      if (scansWanted > 0 && scansEnded >= scansWanted) setTimeout(() => finish(conn, `${scansEnded} scans ended`), 1000);
    }
  }

  const refused = (what: string) => (err: unknown) => log(`${what}: refused:`, err instanceof Error ? err.message : String(err));

  /** The stand-in agent's answer to a Pending job in `agent_queue`. Each write carries (job id, attempt). */
  function onJob(conn: DbConnection, job: AgentQueueItem): void {
    if (!actAsAgent || job.status.tag !== 'Pending' || claimed.has(job.jobId)) return;
    if (job.kind.tag !== 'Options' && job.kind.tag !== 'ErrandPreview') return;
    claimed.add(job.jobId);
    const attempt = job.attempt + 1;
    const t0 = performance.now();
    const took = () => `${(performance.now() - t0).toFixed(0)} ms`;
    const claim = conn.reducers.agentClaim({ jobId: job.jobId });

    if (job.kind.tag === 'ErrandPreview') {
      // What the form-errand Actor's /preview would return, made up: a 16-hex digest over the fields, a read-back.
      const digest = createHash('sha256').update(`${job.errandId}:${job.formKey}:${job.fieldsJson}`).digest('hex').slice(0, 16);
      claim
        .then(() =>
          conn.reducers.agentAttachPreview({
            jobId: job.jobId,
            attempt,
            status: 'previewed',
            formTitle: job.formTitle || 'Smoke form',
            readBackText: 'Smoke form. Item: water. Nothing will be sent anywhere.',
            readBackJson: '[{"label":"Item","value":"water"}]',
            previewDigest: digest,
            screenshotUrl: '',
            reasonCode: '',
            reason: '',
            previewMs: 0,
          }),
        )
        .then(() => log(`job ${job.jobId}: errand ${job.errandId} previewed with digest ${digest} in ${took()}`))
        .catch(refused(`job ${job.jobId}`));
      return;
    }

    const reply = (text: string, tone: string): OptionInput => ({
      kind: 'reply', text, tone, laugh: false, provenance: 'smoke', sources: [], memoryRefs: [], actionJson: '',
    });
    const yesNo = job.questionText.includes('[yes_no]');
    const errand = job.questionText.includes('[errand]');
    const options: OptionInput[] = yesNo
      ? [reply('Yes, please', 'warm'), reply('No, thanks', 'calm')]
      : errand
        ? [
            {
              ...reply('Send the smoke request', 'calm'),
              kind: 'errand',
              actionJson: JSON.stringify({ formKey: 'smoke_form', formUrl: 'demo', formTitle: 'Smoke form', fields: [{ label: 'Item', value: 'water' }] }),
            },
            reply('Not now', 'neutral'),
          ]
        : [reply('Water', 'neutral'), reply('Tea', 'warm'), reply('Juice', 'calm'), reply('Nothing for now', 'firm')];
    claim
      .then(() =>
        conn.reducers.agentProgress({
          jobId: job.jobId,
          attempt,
          eventKey: `${job.jobId}:${attempt}:plan:started`,
          stage: 'plan',
          status: 'started',
          detail: 'smoke options',
          ms: 0,
          countsJson: '',
          payloadJson: '',
        }),
      )
      .then(() => conn.reducers.agentPublishOptions({ jobId: job.jobId, attempt, answerMode: yesNo ? 'yes_no' : 'pick', options, final: true }))
      .then(() => log(`job ${job.jobId}: claimed (attempt ${attempt}) and published ${options.length} ${yesNo ? 'yes or no' : 'pick'} options in ${took()}`))
      .catch(refused(`job ${job.jobId}`));
  }

  /** A Confirmed errand in `errand_queue`: claim it with the digest the person heard, then report it sent. */
  function onErrand(conn: DbConnection, e: ErrandQueueItem): void {
    if (!actAsAgent || e.status.tag !== 'Confirmed' || submitted.has(e.errandId)) return;
    submitted.add(e.errandId);
    const attempt = e.claimAttempt + 1;
    const t0 = performance.now();
    conn.reducers
      .claimErrand({ errandId: e.errandId, digest: e.confirmedDigest })
      .then(() =>
        conn.reducers.completeErrand({
          errandId: e.errandId,
          attempt,
          status: 'submitted',
          confirmationText: 'Smoke test: the gate released it; nothing was sent anywhere.',
          screenshotUrl: '',
          reasonCode: '',
          reason: '',
          submitMs: 0,
        }),
      )
      .then(() => log(`errand ${e.errandId}: claimed with digest ${e.confirmedDigest} (attempt ${attempt}) and completed in ${(performance.now() - t0).toFixed(0)} ms`))
      .catch(refused(`errand ${e.errandId}`));
  }

  const conn = connect((c, identityHex) => {
    log(`connected to ${DB} as ${identityHex}`);
    c.db.scanState.onInsert((_ctx, row) => onScan(undefined, row, c));
    c.db.scanState.onUpdate((_ctx, old, row) => onScan(old, row, c));
    c.db.cueEvent.onInsert((_ctx, cue) => {
      cues.set(cue.kind, (cues.get(cue.kind) ?? 0) + 1);
      log(`cue ${cue.kind}${cue.reason ? ` (${cue.reason})` : ''}${cue.rank ? ` rank ${cue.rank}` : ''}`);
    });
    c.db.deviceStatus.onUpdate((_ctx, old, row) => {
      if (old.online !== row.online) log(`device ${row.label} (${row.role.tag}) ${row.online ? 'online' : 'offline'}`);
    });
    c.db.agentQueue.onInsert((_ctx, job) => onJob(c, job));
    c.db.agentQueue.onUpdate((_ctx, _old, job) => onJob(c, job));
    c.db.errandQueue.onInsert((_ctx, e) => onErrand(c, e));
    c.db.errandQueue.onUpdate((_ctx, _old, e) => onErrand(c, e));
    c.subscriptionBuilder()
      .onApplied(() => {
        log(`subscribed: ${c.db.scanState.count()} scan_state rows, ${c.db.deviceStatus.count()} devices, ${c.db.agentQueue.count()} jobs for me`);
        for (const job of c.db.agentQueue.iter()) onJob(c, job);
        for (const e of c.db.errandQueue.iter()) onErrand(c, e);
      })
      .onError((ctx) => log('subscription error:', ctx.event?.message ?? 'unknown'))
      .subscribe(['SELECT * FROM scan_state', 'SELECT * FROM device_status', 'SELECT * FROM cue_event', 'SELECT * FROM agent_queue', 'SELECT * FROM errand_queue']);
    setTimeout(() => finish(c, `${seconds} s passed`), seconds * 1000);
    process.on('SIGTERM', () => finish(c, 'SIGTERM'));
    process.on('SIGINT', () => finish(c, 'SIGINT'));
  });
  void conn;
}

if (mode === 'pair') pair();
else if (mode === 'watch') watch();
else {
  console.error('usage: watch-scan.ts pair [--code 123456] [--label "smoke agent"] | watch [--seconds 60] [--scans N] [--act-as-agent]');
  process.exit(2);
}
