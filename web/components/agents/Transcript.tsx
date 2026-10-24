'use client';

/**
 * The call's transcript (docs/ui.md "Screen 2"): who spoke and what they said, newest at the
 * bottom. New lines grow in at the bottom (240 ms). The list follows the newest line until the
 * viewer scrolls up; then "Jump to latest" brings it back. Every line is masked for phone numbers,
 * since the call agent's welcome speaks a callback number.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckIcon, NoEntryIcon } from '@/components/ui/icons';
import { TextLink } from '@/components/ui/TextLink';
import { cx } from '@/lib/cx';
import type { CallRequest } from '@/lib/data/types';
import { formatClock, maskPhoneNumbers } from '@/lib/format';
import { screenText } from './model';
import styles from './Transcript.module.css';

/** Within this many px of the bottom counts as "at the newest line". */
const NEAR_END_PX = 24;

function emptySentence(call: CallRequest): string {
  switch (call.status) {
    case 'connected':
      return 'Waiting for the first words.';
    case 'prepared':
    case 'awaiting_confirm':
    case 'confirmed':
    case 'dialing':
    case 'ringing':
      return 'The transcript starts when the call connects.';
    case 'stopped':
    case 'refused':
      return 'No call was placed, so there is no transcript.';
    case 'ended':
    case 'failed':
      return call.startedAt !== null ? 'No transcript lines.' : 'The call never connected, so there is no transcript.';
  }
}

export function Transcript({ call }: { call: CallRequest }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const followRef = useRef(true);
  const [follow, setFollow] = useState(true);
  const lines = call.transcript;
  const recipient = screenText(call.contactName) ?? 'Contact';

  const toEnd = useCallback(() => {
    const scroller = scrollRef.current;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }, []);

  // While following, keep the newest line in view, also while it grows in.
  useEffect(() => {
    const list = listRef.current;
    if (!list || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (followRef.current) toEnd();
    });
    observer.observe(list);
    return () => observer.disconnect();
  }, [toEnd]);

  useEffect(() => {
    if (followRef.current) toEnd();
  }, [lines.length, toEnd]);

  const onScroll = () => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const atEnd = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= NEAR_END_PX;
    followRef.current = atEnd;
    setFollow(atEnd);
  };

  const jumpToLatest = () => {
    followRef.current = true;
    setFollow(true);
    toEnd();
  };

  return (
    <section className={styles.transcript} aria-label="Call transcript">
      <div className={styles.head}>
        <span>{call.status === 'connected' ? 'Live transcript' : 'Transcript'}</span>
        <span className={styles.consent}>
          {call.consentOnFile ? <CheckIcon /> : <NoEntryIcon />}
          {call.consentOnFile ? 'Consent on file' : 'No consent on file'}
        </span>
      </div>
      <div
        ref={scrollRef}
        className={styles.scroll}
        onScroll={onScroll}
        role="log"
        aria-label="Transcript lines"
        tabIndex={lines.length > 0 ? 0 : undefined}
      >
        <ol ref={listRef} className={styles.lines}>
          {lines.map((line) => (
            <li key={line.id} className={cx(styles.line, line.role === 'recipient' && styles.them)}>
              <div className={styles.lineInner}>
                <span className={styles.who}>
                  {line.role === 'assistant' ? 'Assistant' : recipient}
                  <span className="num"> · {formatClock(line.at)}</span>
                </span>
                <p className={styles.text}>&quot;{maskPhoneNumbers(line.text.trim())}&quot;</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
      {lines.length === 0 ? <p className={styles.empty}>{emptySentence(call)}</p> : null}
      {!follow && lines.length > 0 ? (
        <TextLink onClick={jumpToLatest} className={styles.jump}>
          Jump to latest
        </TextLink>
      ) : null}
    </section>
  );
}
