'use client';

/**
 * One database's public stats route (docs/spacetime.md 6.2): the links, and the counts fetched in this browser. The
 * route answers with CORS `*` and needs no key. Anything that is not a stats answer, a failed fetch or a timeout shows
 * one sentence and the raw error as a tooltip; a number is shown only when the answer held it.
 */
import { useEffect, useState } from 'react';
import { Spinner } from '@/components/ui/Spinner';
import { TextLink } from '@/components/ui/TextLink';
import { routeUrl, STATS_TIMEOUT, STATS_WORDS, statsView, type StatsView } from './model';
import styles from './Judge.module.css';

type FetchState = { kind: 'loading' } | { kind: 'done'; view: StatsView } | { kind: 'failed'; errorText: string };

export function StatsCheck({ db, note }: { db: string; note: string }) {
  const [state, setState] = useState<FetchState>({ kind: 'loading' });

  useEffect(() => {
    let disposed = false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('no answer in time')), STATS_TIMEOUT);
    fetch(routeUrl(db, 'stats'), { signal: controller.signal, cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return (await response.json()) as unknown;
      })
      .then(
        (body) => {
          if (!disposed) setState({ kind: 'done', view: statsView(body) });
        },
        (error: unknown) => {
          if (!disposed) setState({ kind: 'failed', errorText: error instanceof Error ? error.message : String(error) });
        },
      )
      .finally(() => clearTimeout(timer));
    return () => {
      disposed = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [db]);

  return (
    <div className={styles.db}>
      <div className={styles.dbHead}>
        <span className={`${styles.dbName} mono`}>{db}</span>
        <span className={styles.dbLinks}>
          <TextLink href={routeUrl(db, 'stats')}>
            {STATS_WORDS.statsLink}
            <span className="visually-hidden"> for {db}</span>
          </TextLink>
          <TextLink href={routeUrl(db, 'ping')}>
            {STATS_WORDS.pingLink}
            <span className="visually-hidden"> for {db}</span>
          </TextLink>
        </span>
      </div>
      <p className={styles.dbNote}>{note}</p>
      <div className={styles.dbStats} aria-live="polite" aria-busy={state.kind === 'loading'}>
        <StatsBody state={state} />
      </div>
    </div>
  );
}

function StatsBody({ state }: { state: FetchState }) {
  if (state.kind === 'loading') {
    return (
      <p className={styles.dbState}>
        <Spinner size={14} />
        <span>{STATS_WORDS.loading}</span>
      </p>
    );
  }
  if (state.kind === 'failed') {
    return (
      <p className={styles.dbState} title={state.errorText}>
        {STATS_WORDS.failed}
      </p>
    );
  }
  const { view } = state;
  if (view.kind === 'no_session') return <p className={styles.dbState}>{STATS_WORDS.noSession}</p>;
  if (view.kind === 'invalid') return <p className={styles.dbState}>{STATS_WORDS.invalid}</p>;
  return (
    <dl className={styles.fields}>
      <div className={styles.field}>
        <dt>{STATS_WORDS.session}</dt>
        <dd className="num">{view.session}</dd>
      </div>
      {view.fields.map((field) => (
        <div key={field.label} className={styles.field}>
          <dt>{field.label}</dt>
          <dd className="num">{field.value}</dd>
        </div>
      ))}
    </dl>
  );
}
