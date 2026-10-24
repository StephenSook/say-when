'use client';

/**
 * The partner's main action (docs/ui.md "Screen 4"): one large "Hold to ask" button with a live
 * microphone level. Hold it with a finger, the mouse, or Space or Enter; let go to stop.
 *
 * For now it only shows the Listening state: Cartesia Ink-2 speech to text is wired in later, so
 * nothing said is turned into a question yet, and the note under the button says so on screen.
 * The level is real: it comes from this phone's microphone, opened only while the button is held.
 * `onHoldChange` is where push to talk hooks in (cartesia/README.md, "The partner phone, push to talk");
 * once it is passed, the note becomes "Listening only while you hold."
 */
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { cx } from '@/lib/cx';
import { MicMeter, type MicStatus } from './micMeter';
import styles from './HoldToAsk.module.css';

/** A stuck hold (a lost pointer event) never keeps the microphone open longer than this. */
const MAX_HOLD_MS = 60_000;

type HoldBy = 'pointer' | 'key';
type Problem = 'blocked' | 'unavailable' | null;

export interface HoldToAskProps {
  /** Called with true when a hold starts and false when it ends. */
  onHoldChange?: (held: boolean) => void;
  disabled?: boolean;
  className?: string;
}

export function HoldToAsk({ onHoldChange, disabled = false, className }: HoldToAskProps) {
  const noteId = useId();
  /** Push to talk is wired in only when someone listens to the hold. Until then nothing said is sent. */
  const wired = onHoldChange !== undefined;
  const levelRef = useRef<HTMLSpanElement>(null);
  const holdBy = useRef<HoldBy | null>(null);
  const meterRef = useRef<MicMeter | null>(null);
  const onHoldChangeRef = useRef(onHoldChange);
  const [held, setHeld] = useState(false);
  const [mic, setMic] = useState<MicStatus>('off');
  const [problem, setProblem] = useState<Problem>(null);

  useEffect(() => {
    onHoldChangeRef.current = onHoldChange;
  }, [onHoldChange]);

  const meter = useCallback((): MicMeter => {
    if (!meterRef.current) {
      meterRef.current = new MicMeter({
        // Straight onto the bars, about 60 times a second, without a React render.
        onLevel: (level) => levelRef.current?.style.setProperty('--level', level.toFixed(3)),
        onStatus: (status) => {
          setMic(status);
          if (status === 'on') setProblem(null);
          else if (status === 'blocked' || status === 'unavailable') setProblem(status);
        },
      });
    }
    return meterRef.current;
  }, []);

  const begin = useCallback(
    (by: HoldBy) => {
      if (holdBy.current !== null) return;
      holdBy.current = by;
      setHeld(true);
      meter().start();
      onHoldChangeRef.current?.(true);
    },
    [meter],
  );

  /** Ends the hold. With `by`, only a hold that started that way (a key up never ends a finger hold). */
  const end = useCallback((by?: HoldBy) => {
    if (holdBy.current === null || (by !== undefined && holdBy.current !== by)) return;
    holdBy.current = null;
    setHeld(false);
    meterRef.current?.stop();
    onHoldChangeRef.current?.(false);
  }, []);

  // Let go when the page is hidden or loses focus, and when this button goes away.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') end();
    };
    const onWindowBlur = () => end();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('blur', onWindowBlur);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('blur', onWindowBlur);
      end();
      meterRef.current?.stop();
    };
  }, [end]);

  // While held: a release anywhere on the page ends it, and so does the time limit.
  useEffect(() => {
    if (!held) return;
    const onRelease = () => end('pointer');
    const limit = setTimeout(() => end(), MAX_HOLD_MS);
    window.addEventListener('pointerup', onRelease);
    window.addEventListener('pointercancel', onRelease);
    return () => {
      clearTimeout(limit);
      window.removeEventListener('pointerup', onRelease);
      window.removeEventListener('pointercancel', onRelease);
    };
  }, [held, end]);

  useEffect(() => {
    if (disabled) end();
  }, [disabled, end]);

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // No pointer capture here; the page-wide release above still ends the hold.
    }
    begin('pointer');
  };

  const onPointerEnd = () => end('pointer');

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      if (!event.repeat && !disabled) begin('key');
    } else if (event.key === 'Escape') {
      end('key');
    }
  };

  const onKeyUp = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      end('key');
    }
  };

  let label = 'Hold to ask';
  if (held) label = mic === 'blocked' ? 'Microphone blocked' : mic === 'unavailable' ? 'No microphone' : 'Listening';

  // Said on screen, not only to screen readers: a judge who holds the button must not think it asked.
  let note = wired ? 'Listening only while you hold.' : 'Speech to text is not connected yet, so nothing you say is sent.';
  if (problem === 'blocked') note = 'Microphone blocked. Allow it in the browser settings, then hold again.';
  else if (problem === 'unavailable') note = 'This browser cannot use the microphone here.';

  return (
    <div className={cx(styles.hold, className)}>
      <button
        type="button"
        className={styles.button}
        disabled={disabled}
        aria-pressed={held}
        aria-describedby={noteId}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onLostPointerCapture={onPointerEnd}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onBlur={() => end()}
        onContextMenu={(event) => event.preventDefault()}
      >
        <span ref={levelRef} className={styles.level} aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
          <span />
        </span>
        <span className={styles.label}>{label}</span>
      </button>
      <p id={noteId} className={styles.note}>
        {note}
      </p>
    </div>
  );
}
