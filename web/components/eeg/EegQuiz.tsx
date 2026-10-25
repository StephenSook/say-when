'use client';

import { useEffect, useRef, useState } from 'react';
import { cx } from '@/lib/cx';
import { EEG_PORT, parseLiveFrame, type EegFrame } from '@/lib/eeg/live';
import { idleQuiz, onCommand, pickQuestions, score, secondsLeft, startQuiz, tick, type QuizState } from '@/lib/eeg/quiz';
import { DECODER_RETRY_MS, HEALTH_FRESH_MS, decoderUrl } from '@/lib/station/decoder';
import styles from './EegQuiz.module.css';

type Link = 'connecting' | 'open' | 'closed';

const BARS: { key: string; label: string }[] = [
  { key: 'right', label: 'Right (TRUE)' },
  { key: 'left', label: 'Left (FALSE)' },
  { key: 'rest', label: 'Rest' },
];

/**
 * /quiz: a true or false practice quiz on the EEG laptop, with the decoder's live left, right and rest bars.
 * The live brain is Screen 1 at /brain.
 * It talks only to the local decoder (ws://127.0.0.1:8765, eeg-data/live.py) and nothing else: no module,
 * no agent. TRUE is the imagined right fist (PICK_2, or YES in the scan map), FALSE the left fist (PICK_1 or NO).
 */
export function EegQuiz() {
  const [link, setLink] = useState<Link>('connecting');
  const [frame, setFrame] = useState<EegFrame | null>(null);
  const [healthAt, setHealthAt] = useState(0);
  const [healthy, setHealthy] = useState(false);
  const [quiz, setQuiz] = useState<QuizState>(idleQuiz);
  const [now, setNow] = useState(() => Date.now());
  const [commands, setCommands] = useState<string[]>([]);
  const [count, setCount] = useState(10);
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let closed = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      setLink('connecting');
      const ws = new WebSocket(decoderUrl(EEG_PORT));
      socketRef.current = ws;
      ws.onopen = () => {
        attempt = 0;
        setLink('open');
      };
      ws.onmessage = (event) => {
        const parsed = parseLiveFrame(event.data);
        if (parsed.kind === 'eeg') setFrame(parsed.frame);
        else if (parsed.kind === 'health') {
          setHealthy(parsed.healthy);
          setHealthAt(Date.now());
        } else if (parsed.kind === 'gesture') {
          const at = Date.now();
          setQuiz((q) => onCommand(q, parsed.command, parsed.confidence, at));
          setCommands((list) => [`${new Date(at).toLocaleTimeString()}  ${parsed.command}  ${parsed.source}`, ...list].slice(0, 6));
        }
      };
      ws.onclose = () => {
        setLink('closed');
        if (closed) return;
        timer = setTimeout(connect, DECODER_RETRY_MS[Math.min(attempt, DECODER_RETRY_MS.length - 1)]);
        attempt += 1;
      };
    };
    connect();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      socketRef.current?.close();
    };
  }, []);

  useEffect(() => {
    const id = setInterval(() => {
      const t = Date.now();
      setNow(t);
      setQuiz((q) => tick(q, t));
    }, 100);
    return () => clearInterval(id);
  }, []);

  const fresh = healthy && now - healthAt < HEALTH_FRESH_MS;
  const statusWords =
    link === 'open' ? (fresh ? 'Headset live' : 'Decoder connected, headset not ready') : link === 'connecting' ? 'Connecting to the decoder' : `Decoder not found on 127.0.0.1:${EEG_PORT}`;
  const live = link === 'open' && frame !== null;
  const s = score(quiz);
  const question = quiz.questions[quiz.index];
  const last = quiz.results[quiz.results.length - 1];
  const left = secondsLeft(quiz, now);
  const counting = quiz.phase === 'asking' && now - quiz.askedAt >= 1_000;

  return (
    <main id="main" className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>Headset</h1>
        <span className={cx(styles.status, fresh ? styles.ok : link === 'closed' ? styles.bad : styles.waiting)} role="status">
          {statusWords}
          {live ? `  ${Math.round(frame.samplesPerSecond)} samples/s` : ''}
        </span>
      </header>

      <div className={styles.grid}>
        <section className={styles.card} aria-label="Signal">
          <p className={styles.caption}>
            What the decoder reads right now. The full live brain is on <a href="/brain">/brain</a>.
          </p>
          <div className={styles.bars}>
            {BARS.map((b) => {
              const v = frame?.proba[b.key] ?? 0;
              return (
                <div key={b.key} className={styles.barRow}>
                  <span className={styles.barLabel}>{b.label}</span>
                  <span className={styles.track}>
                    <span className={cx(styles.fill, styles[b.key])} style={{ width: `${Math.round(v * 100)}%` }} />
                  </span>
                  <span className={styles.barValue}>{Math.round(v * 100)}%</span>
                </div>
              );
            })}
            <div className={styles.barRow}>
              <span className={styles.barLabel}>Jaw</span>
              <span className={styles.track}>
                <span className={cx(styles.fill, styles.jaw)} style={{ width: `${Math.min(100, Math.round(((frame?.jaw ?? 0) / (frame?.jawThreshold ?? 20)) * 100))}%` }} />
              </span>
              <span className={styles.barValue}>{Math.round(frame?.jaw ?? 0)}x</span>
            </div>
          </div>
        </section>

        <section className={styles.card} aria-label="True or false quiz">
          <p className={styles.mapping}>TRUE: imagine squeezing your right fist. FALSE: your left fist.</p>
          {quiz.phase === 'idle' || quiz.phase === 'done' ? (
            <div className={styles.start}>
              {quiz.phase === 'done' ? (
                <p className={styles.question}>
                  {s.right} of {s.asked} right
                  <span className={styles.sub}>
                    {s.answered} answered, chance is half
                  </span>
                </p>
              ) : (
                <p className={styles.question}>True or false, answered with the headset</p>
              )}
              <label className={styles.countLabel}>
                Questions
                <input type="number" min={1} max={30} value={count} onChange={(e) => setCount(Math.max(1, Math.min(30, Number(e.target.value) || 1)))} />
              </label>
              <button type="button" className={styles.button} onClick={() => setQuiz(startQuiz(pickQuestions(count), Date.now()))}>
                {quiz.phase === 'done' ? 'Start again' : 'Start'}
              </button>
            </div>
          ) : quiz.phase === 'result' && last ? (
            <div className={cx(styles.banner, last.said === null ? styles.none : last.correct ? styles.right : styles.wrong)} role="status">
              <span className={styles.bannerBig}>{last.said === null ? 'No answer' : last.said ? 'TRUE' : 'FALSE'}</span>
              <span className={styles.bannerSmall}>
                {last.said === null ? `It was ${last.question.answer ? 'true' : 'false'}` : last.correct ? 'Correct' : `Wrong, it was ${last.question.answer ? 'true' : 'false'}`}
              </span>
            </div>
          ) : question ? (
            <div>
              <p className={styles.progress}>
                Question {quiz.index + 1} of {quiz.questions.length}
              </p>
              <p className={styles.question}>{question.text}</p>
              <p className={styles.timer}>{counting ? `${left} s` : 'Get ready'}</p>
            </div>
          ) : null}
          <p className={styles.meta}>
            Score {s.right} of {s.asked}
          </p>
          {commands.length ? (
            <ul className={styles.commands} aria-label="Last commands">
              {commands.map((c, i) => (
                <li key={`${c}-${i}`}>{c}</li>
              ))}
            </ul>
          ) : null}
        </section>
      </div>
    </main>
  );
}
