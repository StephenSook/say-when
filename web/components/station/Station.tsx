'use client';

/**
 * The station page (docs/station.md 2.2): one focus, what is in the earpiece now. The wearer never looks at it; it is
 * for the operator and the judges, so it shows in words, with an icon and a color for every state:
 *   - the connection, the input (decoder health, or the keyboard test or USB switch named as such), the earpiece,
 *     the voice check and the heartbeat, as chips at the top
 *   - a banner whenever the input is a stand-in: "Keyboard test input. These are key presses, not headset signals."
 *   - one large status sentence, then what is in the earpiece now, the last commands with their outcomes, and the
 *     session line
 * Before a session: the pairing card, then the setup steps and Start session. Errors are big sentences with
 * role="alert"; the raw error text is a tooltip only. Words follow the room's sharing toggle.
 *
 * All the logic lives in lib/station (engine and pure model); this file only renders the engine's snapshot.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { DeviceChip, PairingCard, RoleConnectionChip, runStatusChip, StartAudio, VoiceStatus, EARPIECE_LABELS } from '@/components/device';
import { useCopy } from '@/components/device/useCopy';
import { cx } from '@/lib/cx';
import { showsPairingCard } from '@/lib/role/pairing';
import { roleSettingsFromEnv } from '@/lib/role/settings';
import { StationEngine } from '@/lib/station/engine';
import {
  bigStatus,
  decoderNotes,
  heartbeatChip,
  inputBanner,
  inputChip,
  keyboardLegend,
  lastWorkLine,
  sessionLine,
  timingLine,
  tuningNotes,
  type BigStatus,
} from '@/lib/station/model';
import type { StationSnapshot } from '@/lib/station/snapshot';
import { STATUS_WORDS } from '@/lib/status';
import { useNow } from '@/lib/use-now';
import { CommandList } from './CommandList';
import { EarpieceNow } from './EarpieceNow';
import { StationSetup } from './StationSetup';
import styles from './Station.module.css';

const noSubscribe = () => () => {};
const noSnapshot = () => null;

/** Makes the engine once, in an effect (never during the server render), starts it, and stops it on unmount. */
function useStationEngine(): { engine: StationEngine | null; snapshot: StationSnapshot | null } {
  const ref = useRef<StationEngine | null>(null);
  const [engine, setEngine] = useState<StationEngine | null>(null);
  useEffect(() => {
    if (!ref.current) {
      ref.current = new StationEngine({ settings: roleSettingsFromEnv(), pronunciationDictId: process.env.NEXT_PUBLIC_CARTESIA_DICT_ID });
    }
    const made = ref.current;
    setEngine(made);
    made.start();
    return () => made.stop();
  }, []);
  const snapshot = useSyncExternalStore(engine ? engine.subscribe : noSubscribe, engine ? engine.getState : noSnapshot, noSnapshot);
  return { engine, snapshot };
}

export function Station() {
  const { engine, snapshot } = useStationEngine();
  const now = useNow(250);

  return (
    <section className={styles.root} aria-labelledby="station-title">
      <header className={styles.top}>
        <h1 id="station-title" className={styles.title}>
          NeuroLingo station
        </h1>
        {snapshot ? <Chips s={snapshot} engine={engine} /> : null}
      </header>
      {!snapshot ? (
        <p className={styles.sentence} role="status">
          Starting the station
        </p>
      ) : (
        <StationBody s={snapshot} engine={engine} now={now} />
      )}
    </section>
  );
}

function Chips({ s, engine }: { s: StationSnapshot; engine: StationEngine | null }) {
  return (
    <div className={styles.chips}>
      <RoleConnectionChip state={s.connection} showSentence={false} />
      {s.pairing.phase === 'paired' ? (
        <>
          <span role="status" aria-label="Input">
            <DeviceChip view={inputChip(s)} title={s.decoder?.errorText ?? undefined} />
          </span>
          {!s.setup.silent ? (
            <span role="status" aria-label="Earpiece">
              <DeviceChip view={audioChip(s)} title={s.audio.errorText ?? undefined} />
            </span>
          ) : null}
          {!s.setup.silent ? <VoiceStatus voice={s.voice} onRetry={() => engine?.retryVoice()} /> : null}
          <span role="status" aria-label="Heartbeat">
            <DeviceChip view={heartbeatChip(s)} title={s.heartbeat.refusedText ?? undefined} />
          </span>
        </>
      ) : null}
    </div>
  );
}

function audioChip(s: StationSnapshot) {
  if (s.audio.state === 'running') return runStatusChip('done', EARPIECE_LABELS.running);
  if (s.audio.state === 'failed' || s.audio.state === 'unsupported') return runStatusChip('failed', 'Earpiece off');
  if (s.audio.state === 'starting') return runStatusChip('working', 'Starting audio');
  return runStatusChip('not_started', 'Earpiece off');
}

function StationBody({ s, engine, now }: { s: StationSnapshot; engine: StationEngine | null; now: number }) {
  const banner = inputBanner(s);
  const status = bigStatus(s, now);
  const running = s.session.ownership === 'mine' || s.session.ownership === 'claiming';
  const showPairing = s.hasSettings && (showsPairingCard(s.pairing.phase) || s.pairing.phase === 'connecting' || s.pairing.phase === 'checking');
  const keysOff = s.keysOffAt !== null && now > 0 && now - s.keysOffAt < 3_000;

  return (
    <div className={styles.body}>
      {banner ? (
        <p className={styles.banner} role="note">
          {banner}
        </p>
      ) : null}
      {s.connection.status !== 'live' ? <RoleConnectionChip state={s.connection} onForget={() => engine?.device?.forget()} className={styles.connection} /> : null}

      <StatusBlock status={status} />

      {keysOff ? (
        <p className={styles.notice} role="status">
          Keys are off in headset mode.
        </p>
      ) : null}
      {decoderNotes(s).map((note) => (
        <p key={note} className={styles.notice} role="status">
          {note}
        </p>
      ))}

      {showPairing ? (
        <PairingCard device={engine?.device ?? null} pairing={s.pairing} />
      ) : !s.hasSettings ? null : running ? (
        <RunningSession s={s} engine={engine} now={now} />
      ) : (
        <NotRunning s={s} engine={engine} />
      )}
    </div>
  );
}

function StatusBlock({ status }: { status: BigStatus }) {
  const { result, copy } = useCopy();
  return (
    <div className={cx(styles.status, styles[status.status])}>
      {/* Only the state and its title are announced; the countdown sentence below changes every frame. */}
      <div className={styles.statusLive} role={status.alert ? 'alert' : 'status'}>
        <DeviceChip view={runStatusChip(status.status, STATUS_WORDS[status.status])} />
        <p className={styles.statusTitle}>{status.title}</p>
      </div>
      {status.sentence ? <p className={styles.sentence}>{status.sentence}</p> : null}
      {status.command ? (
        <div className={styles.commandRow}>
          <code className={styles.command}>{status.command}</code>
          <button type="button" className={styles.secondary} onClick={() => copy('status', status.command ?? '')}>
            {result === 'copied' ? 'Copied' : 'Copy command'}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function RunningSession({ s, engine, now }: { s: StationSnapshot; engine: StationEngine | null; now: number }) {
  const legend = keyboardLegend(s);
  const work = lastWorkLine(s);
  const line = sessionLine(s);
  const needsAudio = !s.setup.silent && s.audio.state !== 'running';
  // A switch that types Enter or Space must not press a focused button: no session button takes focus in switch mode.
  const switchMode = s.setup.mode === 'switch';
  return (
    <>
      {needsAudio ? (
        <div className={styles.alertBlock} role="alert">
          <p className={styles.sentence}>The earpiece is off, so no heartbeats are sent and the scan pauses. Nothing will be sent.</p>
          <StartAudio state={s.audio} onStart={() => void engine?.startAudio()} labels={EARPIECE_LABELS} />
        </div>
      ) : null}
      <EarpieceNow s={s} engine={engine} now={now} />
      {legend ? (
        <p className={styles.legend} aria-label="Keyboard test keys">
          {legend}
        </p>
      ) : null}
      {work ? <p className={styles.sentence}>{work}</p> : null}
      <CommandList commands={s.commands} />
      <div className={styles.sessionRow}>
        {line ? <p className={styles.sentence}>{line}</p> : null}
        <button
          type="button"
          className={styles.secondary}
          onClick={() => engine?.endSession()}
          tabIndex={switchMode ? -1 : undefined}
          disabled={s.session.ownership === 'ending'}
        >
          End session
        </button>
      </div>
      <p className={cx(styles.meta, 'num')}>{timingLine(s)}</p>
      {tuningNotes(s).map((note) => (
        <p key={note} className={styles.notice}>
          {note}
        </p>
      ))}
    </>
  );
}

function NotRunning({ s, engine }: { s: StationSnapshot; engine: StationEngine | null }) {
  if (s.session.id !== null && s.session.ownership !== 'starting') {
    const audioFirst = !s.setup.silent && s.audio.state !== 'running';
    return (
      <div className={styles.card}>
        <p className={styles.lead}>Session {s.session.id.toString()} is active.</p>
        {s.session.ownership === 'other' ? (
          <p className={styles.sentence}>This session belongs to another station. End it there, or the owner ends it.</p>
        ) : (
          <p className={styles.sentence}>Continue it here, or end it. The first heartbeat proves it belongs to this station.</p>
        )}
        <div className={styles.buttons}>
          <button
            type="button"
            className={styles.primary}
            disabled={s.connection.status !== 'live' || !s.setup.mode}
            onClick={() => (audioFirst ? engine?.startAudioAndContinue() : engine?.continueSession())}
          >
            {audioFirst ? `Start audio and continue session ${s.session.id.toString()}` : `Continue session ${s.session.id.toString()}`}
          </button>
          <button type="button" className={styles.secondary} disabled={s.connection.status !== 'live'} onClick={() => engine?.endSession()}>
            End it
          </button>
        </div>
        {!s.setup.mode ? <p className={styles.sentence}>Pick an input mode first.</p> : null}
        {s.session.error ? (
          <p className={styles.error} role="alert">
            {s.session.error}
          </p>
        ) : null}
        <StationSetup s={s} engine={engine} compact />
      </div>
    );
  }
  return <StationSetup s={s} engine={engine} />;
}
