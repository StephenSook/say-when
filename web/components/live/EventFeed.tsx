'use client';

/**
 * The raw event feed, newest first, with Pause (docs/ui.md "Screen 1", after the Supabase Realtime
 * Inspector). Pipeline rows and command events share one list, ignored repeats included,
 * so the room can see the debounce working. Not a live region: it changes too often to read out.
 */
import { useId, useMemo, useState } from 'react';
import { TextLink } from '@/components/ui/TextLink';
import { cx } from '@/lib/cx';
import { useCalls, useCommands, useErrands, useInput, usePipelineEvents } from '@/lib/data/provider';
import { formatClock, formatCount } from '@/lib/format';
import { countNewer, feedItems, type FeedItem } from './model';
import styles from './EventFeed.module.css';

const FEED_LIMIT = 40;

interface Frozen {
  items: FeedItem[];
  newestAt: number;
}

export function EventFeed() {
  const titleId = useId();
  const events = usePipelineEvents();
  const commands = useCommands();
  const errands = useErrands();
  const calls = useCalls();
  const input = useInput();
  const live = useMemo(() => feedItems(events, commands, errands, calls, FEED_LIMIT, input), [events, commands, errands, calls, input]);
  const [frozen, setFrozen] = useState<Frozen | null>(null);

  const shown = frozen?.items ?? live;
  const waiting = frozen ? countNewer(events, commands, frozen.newestAt) : 0;
  const toggle = () => setFrozen(frozen ? null : { items: live, newestAt: live[0]?.at ?? Number.NEGATIVE_INFINITY });

  return (
    <section className={styles.events} aria-labelledby={titleId}>
      <div className={styles.head}>
        <h2 id={titleId} className={styles.title}>
          Events, newest first
        </h2>
        <TextLink onClick={toggle}>{frozen ? 'Resume' : 'Pause'}</TextLink>
        {frozen ? (
          <span className={styles.paused}>
            Feed paused. {waiting === 0 ? 'No new events yet.' : `${formatCount(waiting, 'new event')} waiting.`}
          </span>
        ) : null}
      </div>
      {shown.length === 0 ? (
        <p className={styles.empty}>No events yet.</p>
      ) : (
        <ol className={styles.list}>
          {shown.map((item) => (
            <li key={item.key} className={styles.row}>
              <span className={cx(styles.time, 'num')}>{formatClock(item.at)}</span>
              <span className={styles.name}>{item.name}</span>
              <span className={cx(styles.status, styles[item.tone])}>{item.status}</span>
              <span className={cx(styles.value, 'num')}>{item.value}</span>
              <span className={styles.detail}>{item.detail}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
