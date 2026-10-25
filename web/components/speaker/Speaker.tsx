'use client';

/**
 * The room voice page, /speaker (docs/station.md 3, PLAN row 5.7). It runs on a laptop with a loudspeaker, paired as
 * the Speaker. It says each released reply once, aloud in the room, in the reply voice, then records it with
 * `reply_spoken`. It never sees the options: a Speaker's `my_session` holds only the reply.
 *
 * One focus: the large status line. Every state has a word, a mark and a color (docs/ui.md "Status vocabulary"):
 *   Waiting for a reply.  Paused. Nothing will be said.  Saying it out loud.  Said out loud.
 *   Missed reply to question 7, released 3 min ago.  Could not say the reply.
 * The reply's words show only while the room's sharing toggle is on; otherwise "Reply to question 7".
 *
 * Say read-backs (lib/speaker/mirror.ts, on by default): the room also hears every read-back the headset wearer hears,
 * read from the board views while sharing is on. Since Oct 25 it does not repeat the partner's question or the
 * numbered options. One small status line under the reply says what it is doing, or what it needs (the tap, board
 * sharing).
 */
import { useEffect, useId, useState } from 'react';
import { DeviceChip, PairingCard, RoleConnectionChip, ROOM_VOICE_LABELS, StartAudio, VoiceStatus } from '@/components/device';
import { CheckIcon, CrossIcon, HourglassIcon, PauseIcon } from '@/components/ui/icons';
import { Spinner } from '@/components/ui/Spinner';
import { TextLink } from '@/components/ui/TextLink';
import { wordAt } from '@/lib/cartesia/browser';
import { cx } from '@/lib/cx';
import { VOLUME_RANGE } from '@/lib/role/storage';
import type { SpeakerVoice } from '@/lib/speaker/voice';
import { useNow } from '@/lib/use-now';
import { buildMirrorView, buildSpeakerView, type SpeakerLine, type SpeakerMark } from './model';
import { useSpeaker } from './useSpeaker';
import styles from './Speaker.module.css';

export function Speaker() {
  const speaker = useSpeaker();
  const { device, connection, pairing } = speaker;
  const paired = pairing.phase === 'paired';

  return (
    <section className={styles.root} aria-labelledby="speaker-title">
      <div className={styles.top}>
        <h1 id="speaker-title" className={styles.brand}>
          Eleven room voice
        </h1>
        <RoleConnectionChip state={connection} onForget={() => device?.forget()} />
      </div>

      {speaker.settingsMissing ? (
        <p className={styles.problem} role="alert">
          <CrossIcon size={16} />
          <span>This page has no database to pair with. Set NEXT_PUBLIC_SPACETIMEDB_HOST and NEXT_PUBLIC_SPACETIMEDB_DB.</span>
        </p>
      ) : paired ? (
        <RoomVoice speaker={speaker} />
      ) : (
        <PairingCard device={device} pairing={pairing} />
      )}
    </section>
  );
}

function RoomVoice({ speaker }: { speaker: ReturnType<typeof useSpeaker> }) {
  const { state, room, engine, audio, audioState, voice } = speaker;
  const now = useNow(1_000);
  const statusId = useId();
  const audioRunning = audioState.state === 'running';
  const view = buildSpeakerView({ state, room, now, offsetMs: engine?.clockOffset() ?? 0, audioRunning });
  const mirror = buildMirrorView(speaker.mirror, audioRunning);
  const marking = state.phase === 'speaking' && view.words !== null;

  return (
    <div className={styles.body}>
      <div className={styles.setup}>
        <VoiceStatus voice={speaker.voiceState} onRetry={() => speaker.device?.recheckVoice()} />
        <StartAudio state={audioState} onStart={() => void audio?.start()} labels={ROOM_VOICE_LABELS} />
      </div>

      {view.warning ? (
        <p className={styles.warning} role="alert">
          <CrossIcon size={16} />
          <span>{view.warning}</span>
        </p>
      ) : null}

      <div className={styles.now}>
        <Status id={statusId} line={view.status} announceKey={view.key} />
        {view.words !== null ? (
          <p className={styles.words}>{marking && voice ? <MarkedWords text={state.reply?.text ?? ''} voice={voice} /> : view.words}</p>
        ) : null}
        {view.replyLabel ? <p className={styles.replyLabel}>{view.replyLabel}</p> : null}
        {view.meta ? <p className={cx(styles.meta, 'num')}>{view.meta}</p> : null}
        {view.sayNow ? (
          <button type="button" className={styles.action} onClick={() => engine?.sayNow()}>
            Say it now
          </button>
        ) : null}
        {view.report ? <ReportLine line={view.report} /> : null}
      </div>

      <div className={styles.mirror}>
        <label className={styles.check}>
          <input type="checkbox" checked={speaker.mirror.on} onChange={(event) => speaker.setMirrorOn(event.currentTarget.checked)} />
          <span>Say read-backs</span>
        </label>
        <p className={cx(styles.mirrorLine, styles[mirror.line.tone])} title={mirror.line.title ?? undefined} role="status">
          <span className={styles.mark} data-mark={mirror.line.mark} aria-hidden="true">
            <Mark mark={mirror.line.mark} />
          </span>
          <span>{mirror.line.text}</span>
        </p>
        {mirror.words !== null ? <p className={styles.mirrorWords}>{mirror.words}</p> : null}
      </div>

      <div className={styles.footer}>
        {audioRunning && state.phase !== 'speaking' ? (
          <TextLink onClick={speaker.testVoice}>{speaker.testing ? 'Playing the test' : 'Test voice'}</TextLink>
        ) : null}
        <label className={styles.volume}>
          <span>Volume</span>
          <input
            type="range"
            min={VOLUME_RANGE.min}
            max={VOLUME_RANGE.max}
            step={0.1}
            value={speaker.volume}
            onChange={(event) => speaker.setVolume(Number(event.currentTarget.value))}
            aria-valuetext={speaker.volume.toFixed(1)}
          />
          <span className="num">{speaker.volume.toFixed(1)}</span>
        </label>
      </div>
    </div>
  );
}

function Mark({ mark }: { mark: SpeakerMark }) {
  switch (mark) {
    case 'spinner':
      return <Spinner size={20} />;
    case 'check':
      return <CheckIcon size={16} />;
    case 'cross':
      return <CrossIcon size={16} />;
    case 'pause':
      return <PauseIcon size={16} />;
    case 'hourglass':
      return <HourglassIcon size={16} />;
    case 'ring':
      return <span className={styles.ring} />;
  }
}

/** The large status line. Screen readers hear it when its key changes, not on every render. */
function Status({ id, line, announceKey }: { id: string; line: SpeakerLine; announceKey: string }) {
  const [said, setSaid] = useState({ key: announceKey, text: line.text });
  if (said.key !== announceKey) setSaid({ key: announceKey, text: line.text });
  const failed = line.tone === 'failed';
  return (
    <>
      <p id={id} className={cx(styles.status, styles[line.tone])} title={line.title ?? undefined}>
        <span className={styles.mark} data-mark={line.mark} aria-hidden="true">
          <Mark mark={line.mark} />
        </span>
        <span>{line.text}</span>
      </p>
      <p className="visually-hidden" role={failed ? 'alert' : 'status'}>
        {said.text}
      </p>
    </>
  );
}

function ReportLine({ line }: { line: SpeakerLine }) {
  const chip = {
    words: line.text,
    tone: line.tone === 'done' ? 'accent' : line.tone === 'failed' ? 'error' : line.tone === 'working' ? 'default' : 'muted',
    lead: line.mark === 'spinner' ? 'spinner' : line.mark === 'check' ? 'check' : line.mark === 'cross' ? 'cross' : 'pause',
  } as const;
  return (
    <p className={styles.report}>
      <DeviceChip view={chip} title={line.title ?? undefined} />
    </p>
  );
}

/** The reply's words with the one being said marked, from Cartesia's word timings (sharing on only). */
function MarkedWords({ text, voice }: { text: string; voice: SpeakerVoice }) {
  const [index, setIndex] = useState(-1);
  const tokens = text.trim().split(/\s+/);
  useEffect(() => {
    let frame = 0;
    const tick = () => {
      const words = voice.words();
      setIndex(words.length === tokens.length ? wordAt(words, voice.positionMs()) : -1);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [voice, tokens.length]);
  return (
    <>
      &quot;
      {tokens.map((token, i) => (
        <span key={i} className={i === index ? styles.current : undefined}>
          {i > 0 ? ' ' : ''}
          {token}
        </span>
      ))}
      &quot;
    </>
  );
}
