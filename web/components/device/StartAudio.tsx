'use client';

/**
 * The tap that starts audio (docs/station.md 2.9 "Start audio", 3 "Start room voice", 5.3). The browser plays sound
 * only after a click or a key press, so the AudioContext is made inside this button's handler. After a reload, or
 * when the audio devices change, the same button asks for the tap again.
 */
import { cx } from '@/lib/cx';
import type { AudioUnlockSnapshot } from '@/lib/voice/audio';
import { DeviceChip } from './DeviceChip';
import { audioView, EARPIECE_LABELS, type AudioLabels } from './model';
import styles from './StartAudio.module.css';

export interface StartAudioProps {
  state: AudioUnlockSnapshot;
  /** Call `audio.start()` here, directly in the click, so the browser counts it as the user's gesture. */
  onStart: () => void;
  /** The words: `EARPIECE_LABELS` (default) or `ROOM_VOICE_LABELS`, or the page's own, such as "Start audio and continue session 7". */
  labels?: AudioLabels;
  className?: string;
}

export function StartAudio({ state, onStart, labels = EARPIECE_LABELS, className }: StartAudioProps) {
  const view = audioView(state, labels);
  return (
    <div className={cx(styles.wrap, className)}>
      <span role="status">
        <DeviceChip view={view} title={state.errorText ?? undefined} />
      </span>
      {view.button ? (
        <button type="button" className={styles.button} onClick={onStart} disabled={view.buttonDisabled}>
          {view.button}
        </button>
      ) : null}
      {view.sentence ? <p className={styles.sentence}>{view.sentence}</p> : null}
    </div>
  );
}
