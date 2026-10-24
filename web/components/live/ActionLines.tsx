'use client';

/**
 * What happened after the pick, one line each: the reply said out loud for the room, then the
 * errand and the call, which link to the Agents screen where they are shown step by step
 * (docs/ui.md "Screen 1": "Errand and Call link to Agents").
 */
import { useId } from 'react';
import { Row, RowList } from '@/components/ui/Row';
import { StatusMark } from '@/components/ui/StatusMark';
import { TextLink } from '@/components/ui/TextLink';
import { formatSeconds } from '@/lib/format';
import { Elapsed } from './Elapsed';
import type { ActionLine } from './model';
import styles from './ActionLines.module.css';

export function ActionLines({ lines }: { lines: readonly ActionLine[] }) {
  const id = useId();
  if (lines.length === 0) return null;
  return (
    <section className={styles.actions} aria-labelledby={id}>
      <h2 id={id} className={styles.title}>
        After the pick
      </h2>
      <RowList>
        {lines.map((line) => (
          <Row
            key={line.key}
            current={line.status === 'working' || line.status === 'waiting'}
            main={
              <span className={styles.main}>
                <span className={styles.name}>{line.title}</span>
                <StatusMark status={line.status} word={line.word} />
              </span>
            }
            side={<LineTime line={line} />}
            meta={line.sentence}
            sideMeta={line.kind === 'reply' ? undefined : <TextLink href="/agents">See it on Agents</TextLink>}
          />
        ))}
      </RowList>
    </section>
  );
}

function LineTime({ line }: { line: ActionLine }) {
  const time = line.time;
  if (time?.kind === 'running') {
    return (
      <>
        <Elapsed from={time.from} until={time.until} /> so far
      </>
    );
  }
  if (time?.kind === 'final' && time.ms !== null) return <>{formatSeconds(time.ms)}</>;
  if (time?.kind === 'cut') return <>{formatSeconds(time.ms)}</>;
  return null;
}
