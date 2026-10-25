'use client';

/**
 * Before a session (docs/station.md 2.2, 2.3, 2.5 and 2.10): the steps (Paired, Voice ready, Input mode, Earpiece on,
 * Phrases ready, Input ready), the input mode with its honest name, the decoder port, the switch key, the voice speeds,
 * Start audio, and Start session with its label. The input mode is fixed once a session runs.
 */
import { useId, useState } from 'react';
import { StartAudio, EARPIECE_LABELS } from '@/components/device';
import { StepList, type Step } from '@/components/ui/StepList';
import { TextLink } from '@/components/ui/TextLink';
import { INPUT_MODES, SPEED_RANGE, type InputMode } from '@/lib/role/storage';
import type { StationEngine } from '@/lib/station/engine';
import { MODE_WORDS, sessionLabel, setupSteps, startBlocker } from '@/lib/station/model';
import type { StationSnapshot } from '@/lib/station/snapshot';
import styles from './StationSetup.module.css';

const MODE_NOTES: Readonly<Record<InputMode, string>> = {
  headset:
    'Commands come from the decoder on this laptop (python live.py --mode direct): fists pick 1 and 2, a single jaw clench 3, a held clench (about 1 second) STOP; a double clench does nothing. The fists are imagined movements decoded from EEG; the jaw clench is a muscle signal.',
  keyboard: 'A stand-in for tests: keys 1, 2, 3, S and H. Sent as key presses, never as headset input.',
  switch: 'One physical switch: a short press is 1, two presses 2, a 1 s hold STOP. Option 3 is not on the switch. Sent as switch presses.',
};

export interface StationSetupProps {
  s: StationSnapshot;
  engine: StationEngine | null;
  /** Inside the "Session N is active" card: no Start session button. */
  compact?: boolean;
}

export function StationSetup({ s, engine, compact = false }: StationSetupProps) {
  const id = useId();
  // Step details render at meta size in the shared StepList; this page keeps every word at 16 px or more, so the first
  // blocking step's reason is shown under Start session instead.
  const steps: Step[] = setupSteps(s).map((step) => ({ key: step.key, label: step.label, status: step.status }));
  const blocker = startBlocker(s);
  const mode = s.setup.mode;

  return (
    <div className={styles.setup}>
      {!compact ? <StepList steps={steps} label="Before a session" /> : null}

      <fieldset className={styles.group}>
        <legend className={styles.legend}>Input mode</legend>
        {INPUT_MODES.map((m) => (
          <label key={m} className={styles.choice}>
            <input type="radio" name={`${id}-mode`} value={m} checked={mode === m} onChange={() => engine?.chooseMode(m)} />
            <span>
              <span className={styles.choiceName}>{MODE_WORDS[m]}</span>
              <span className={styles.choiceNote}>{MODE_NOTES[m]}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {mode === 'headset' ? <PortField s={s} engine={engine} /> : null}
      {mode === 'switch' ? <SwitchKey s={s} engine={engine} /> : null}

      {mode === 'keyboard' ? (
        <label className={styles.check}>
          <input type="checkbox" checked={s.setup.silent} onChange={(e) => engine?.setSilent(e.currentTarget.checked)} />
          <span>No earpiece voice (test only). Options are not voiced, and the scan uses estimated lengths.</span>
        </label>
      ) : null}

      {mode === 'headset' || mode === 'switch' ? (
        <fieldset className={styles.group}>
          <legend className={styles.legend}>Purpose</legend>
          {(['demo', 'test'] as const).map((p) => (
            <label key={p} className={styles.choice}>
              <input type="radio" name={`${id}-purpose`} value={p} checked={s.setup.purpose === p} onChange={() => engine?.choosePurpose(p)} />
              <span className={styles.choiceName}>{p === 'demo' ? 'Demo' : 'Test'}</span>
            </label>
          ))}
        </fieldset>
      ) : null}

      {!s.setup.silent ? (
        <>
          <StartAudio state={s.audio} onStart={() => void engine?.startAudio()} labels={EARPIECE_LABELS} />
          <label className={styles.check}>
            <input type="checkbox" checked={s.setup.readQuestion !== false} onChange={(e) => engine?.setReadQuestion(e.currentTarget.checked)} />
            <span>Read the partner&apos;s question in the earpiece before its options.</span>
          </label>
          <Speeds s={s} engine={engine} />
        </>
      ) : null}

      {s.phrases.failed > 0 ? <TextLink onClick={() => engine?.retryPhrases()}>Retry the phrases</TextLink> : null}

      {!compact ? (
        <div className={styles.start}>
          {mode ? <p className={styles.note}>Session label: {sessionLabel(mode, s.setup.purpose)}</p> : null}
          <button type="button" className={styles.primary} disabled={blocker !== null || s.session.ownership === 'starting'} onClick={() => engine?.startSession()}>
            Start session
          </button>
          {blocker ? <p className={styles.note}>{blocker}</p> : null}
          {s.session.error ? (
            <p className={styles.error} role="alert">
              {s.session.error}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function PortField({ s, engine }: { s: StationSnapshot; engine: StationEngine | null }) {
  const id = useId();
  const [draft, setDraft] = useState(String(s.setup.port));
  const [bad, setBad] = useState(false);
  const save = () => {
    const port = Number(draft);
    const ok = Number.isInteger(port) && (engine?.setPort(port) ?? false);
    setBad(!ok);
  };
  return (
    <div className={styles.field}>
      <label htmlFor={`${id}-port`} className={styles.legend}>
        Decoder port on 127.0.0.1
      </label>
      <div className={styles.row}>
        <input
          id={`${id}-port`}
          className={styles.input}
          inputMode="numeric"
          value={draft}
          onChange={(e) => setDraft(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save();
          }}
          aria-invalid={bad}
        />
        <button type="button" className={styles.secondary} onClick={save}>
          Use this port
        </button>
      </div>
      {bad ? (
        <p className={styles.error} role="alert">
          A port is a whole number from 1 to 65535.
        </p>
      ) : null}
    </div>
  );
}

function SwitchKey({ s, engine }: { s: StationSnapshot; engine: StationEngine | null }) {
  return (
    <div className={styles.field}>
      <p className={styles.legend}>Switch key</p>
      {s.setup.learningSwitch ? (
        <p className={styles.lead} role="status">
          Press your switch now. Escape cancels.
        </p>
      ) : (
        <p className={styles.note}>{s.setup.switchKey ? `Learned: ${s.setup.switchKey}` : 'Not learned yet.'}</p>
      )}
      <button type="button" className={styles.secondary} onClick={() => engine?.learnSwitch(!s.setup.learningSwitch)}>
        {s.setup.learningSwitch ? 'Cancel' : 'Learn the switch key'}
      </button>
    </div>
  );
}

function Speeds({ s, engine }: { s: StationSnapshot; engine: StationEngine | null }) {
  const id = useId();
  const field = (which: 'assistant' | 'option', label: string, value: number | null) => (
    <label className={styles.speed} htmlFor={`${id}-${which}`}>
      <span>{label}</span>
      <select
        id={`${id}-${which}`}
        className={styles.input}
        value={value === null ? '' : String(value)}
        onChange={(e) => engine?.setSpeed(which, e.currentTarget.value === '' ? null : Number(e.currentTarget.value))}
      >
        <option value="">Natural</option>
        {SPEEDS.map((speed) => (
          <option key={speed} value={String(speed)}>
            {speed.toFixed(1)}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <details className={styles.details}>
      <summary>Voice speed</summary>
      <div className={styles.speeds}>
        {field('assistant', 'Prompts and read-backs', s.setup.assistantSpeed)}
        {field('option', 'Options', s.setup.optionSpeed)}
      </div>
      <p className={styles.note}>Changing a speed voices the phrases again.</p>
    </details>
  );
}

const SPEEDS: readonly number[] = Array.from({ length: Math.round((SPEED_RANGE.max - SPEED_RANGE.min) * 10) + 1 }, (_, i) => Math.round((SPEED_RANGE.min + i / 10) * 10) / 10);
