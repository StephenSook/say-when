/**
 * Small pieces the errand and call steps share: the step number, a quoted line, a muted note,
 * a digest, and the values read back off the form. Every piece of row text is masked here, so a
 * phone number never reaches the screen.
 */
import { Fragment, type ReactNode } from 'react';
import type { ReadBackItem } from '@/lib/data/types';
import { maskPhoneNumbers } from '@/lib/format';
import { shortDigest } from './model';
import styles from './AgentCard.module.css';

/** A step's label with its number in front. The list is an <ol>, so screen readers already hear the number. */
export function numbered(n: number, label: ReactNode): ReactNode {
  return (
    <>
      <span className={styles.stepNo} aria-hidden="true">
        {n}
      </span>
      {label}
    </>
  );
}

/** What was said or written, in straight quotes. `channel` names where it was heard: "In the earpiece now". */
export function Quote({ text, channel }: { text: string; channel?: string }) {
  return (
    <>
      {channel ? <span className={styles.channel}>{channel}</span> : null}
      <p className={styles.quote}>&quot;{maskPhoneNumbers(text.trim())}&quot;</p>
    </>
  );
}

/** One muted sentence under a step. */
export function Note({ children }: { children: ReactNode }) {
  return <p className={styles.note}>{children}</p>;
}

/** The first 8 characters of a digest in Geist Mono; the full value is in the tooltip. */
export function Digest({ value }: { value: string }) {
  const short = shortDigest(value);
  if (!short) return null;
  return (
    <span className={styles.digest} title={`Full digest ${value.trim()}. A CONFIRM counts only if it matches.`}>
      {short}
    </span>
  );
}

/** The values the form agent read back off the filled page, label beside value. */
export function ReadBackValues({ items }: { items: readonly ReadBackItem[] }) {
  return (
    <dl className={styles.values}>
      {items.map((item, i) => (
        <Fragment key={`${i}:${item.label}`}>
          <dt>{maskPhoneNumbers(item.label)}</dt>
          <dd>
            {maskPhoneNumbers(item.value)}
            {item.source ? <span className={styles.from}> · from {maskPhoneNumbers(item.source)}</span> : null}
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}
