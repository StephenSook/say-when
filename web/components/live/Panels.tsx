'use client';

/**
 * The full rows behind three steps: what Apify found, what Moss recalled and what Claude drafted.
 * Every web row shows its source and fetch time, and every Moss hit says whether it came from
 * memory or the web, which answers a judge's first trust question: where did this come from, and
 * how fresh is it? (docs/ui.md "Screen 1"). Memory text shows only through hitDisplay.
 */
import { useId, type ReactNode } from 'react';
import { CrossIcon } from '@/components/ui/icons';
import { Row, RowList } from '@/components/ui/Row';
import { StatusLine, type StatusLineProps } from '@/components/ui/StatusLine';
import { cx } from '@/lib/cx';
import { hitDisplay } from '@/lib/data/derive';
import type { AnswerOption, MossHit, OptionKind, SearchRow, SourceRef } from '@/lib/data/types';
import { formatClock, formatCount, formatDate, formatMs, formatSeconds } from '@/lib/format';
import type { DraftPanel, RecallPanel, SearchPanel, StageCard } from './model';
import styles from './Panels.module.css';

/** At most this many rows per panel; the rest are counted. */
const MAX_ROWS = 8;

export function Panels({ search, recall, draft }: { search: SearchPanel; recall: RecallPanel; draft: DraftPanel }) {
  return (
    <div className={styles.panels}>
      <SearchView panel={search} />
      <RecallView panel={recall} />
      <DraftView panel={draft} />
    </div>
  );
}

function Panel({ title, meta, children }: { title: string; meta: string | null; children: ReactNode }) {
  const id = useId();
  return (
    <section className={styles.panel} aria-labelledby={id}>
      <h2 id={id} className={styles.title}>
        <span>{title}</span>
        {meta ? <span className={cx(styles.titleMeta, 'num')}>{meta}</span> : null}
      </h2>
      {children}
    </section>
  );
}

/** What a panel says when it has no rows to list: a wait, a failure, or the step's own note. */
function Note({ card, waiting }: { card: StageCard; waiting: StatusLineProps['messages'] }) {
  if (card.status === 'working') {
    return <StatusLine messages={waiting} resetKey={card.eventId ?? undefined} align="start" className={styles.wait} />;
  }
  if (card.status === 'failed') {
    return (
      <p className={cx(styles.note, styles.noteError)} title={card.payloadTitle ?? undefined}>
        <CrossIcon size={12} className={styles.noteIcon} />
        <span>{card.payload}</span>
      </p>
    );
  }
  return <p className={styles.note}>{card.payload}</p>;
}

function More({ total }: { total: number }) {
  return total > MAX_ROWS ? <p className={styles.more}>And {formatCount(total - MAX_ROWS, 'more row')}</p> : null;
}

function finalMs(card: StageCard): number | null {
  return card.time?.kind === 'final' ? card.time.ms : null;
}

// ---------------------------------------------------------------------------------------------
// Apify found

function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

function sourceWords(source: string | undefined, url?: string): string {
  if (source === 'maps') return 'Google Maps';
  if (source === 'memory') return 'Memory';
  const host = hostOf(url);
  return host ? `Web, ${host}` : 'Web';
}

function fetchedWords(fetchedAt: string | undefined): string | null {
  const clock = fetchedAt ? formatClock(fetchedAt) : '';
  return clock ? `fetched ${clock}` : null;
}

function SearchView({ panel }: { panel: SearchPanel }) {
  const { card, rows } = panel;
  let meta: string | null = null;
  if (card.status === 'done' && panel.rowCount !== null && card.passed !== 'no search') {
    meta = `${formatCount(panel.rowCount, 'row')} from ${formatCount(panel.searches, 'search', 'searches')}`;
  }
  return (
    <Panel title="Apify found" meta={meta}>
      {rows.length > 0 && card.status !== 'working' ? (
        <>
          <RowList label="Apify rows" className={styles.list} key={card.eventId ?? 'rows'}>
            {rows.slice(0, MAX_ROWS).map((row, i) => (
              <SearchRowView key={`${row.id ?? 'row'}:${i}`} row={row} />
            ))}
          </RowList>
          <More total={rows.length} />
          {panel.partial ? <p className={styles.more}>Some results were cut short.</p> : null}
          {panel.failedNote ? <p className={styles.more}>One search failed: {panel.failedNote}</p> : null}
        </>
      ) : (
        <Note card={card} waiting={['Searching Google Maps and the web', 'Still searching', 'Still searching. Web results can take a few seconds.']} />
      )}
    </Panel>
  );
}

/** A trimmed string, or null for anything else. Rows come from producers, so nothing is assumed. */
function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function SearchRowView({ row }: { row: SearchRow }) {
  const title = str(row.title) ?? 'Untitled result';
  const summary = str(row.text);
  const url = str(row.url) ?? undefined;
  const source = sourceWords(str(row.source) ?? undefined, url);
  return (
    <Row
      main={title}
      side={fetchedWords(str(row.fetchedAt) ?? undefined) ?? undefined}
      meta={<span className={styles.clamp}>{summary ? `${source}. ${summary}` : source}</span>}
      title={url ?? summary ?? undefined}
    />
  );
}

// ---------------------------------------------------------------------------------------------
// Moss recalled

function hitMeta(hit: MossHit, category: string | null): string {
  if (hit.origin === 'web') {
    // Always say "Web" first: every hit shows whether it came from memory or the web (docs/ui.md).
    const ref: Partial<SourceRef> = hit.source !== null && typeof hit.source === 'object' ? hit.source : {};
    const where = str(ref.source) === 'maps' ? 'Google Maps' : hostOf(str(ref.url) ?? undefined);
    return ['Web', where, fetchedWords(str(ref.fetchedAt) ?? undefined)].filter(Boolean).join(', ');
  }
  const saved = typeof hit.savedAt === 'number' ? formatDate(hit.savedAt) : '';
  return ['Memory', category ? category.toLowerCase() : null, saved ? `saved ${saved}` : null].filter(Boolean).join(', ');
}

function RecallView({ panel }: { panel: RecallPanel }) {
  const { card, hits } = panel;
  const ms = finalMs(card);
  let meta: string | null = null;
  if (card.status === 'done' && panel.hitCount !== null) {
    meta = ms === null ? formatCount(panel.hitCount, 'hit') : `${formatCount(panel.hitCount, 'hit')} in ${formatMs(ms)}`;
  }
  return (
    <Panel title="Moss recalled" meta={meta}>
      {hits.length > 0 && card.status !== 'working' ? (
        <>
          <RowList label="Moss hits" className={styles.list} key={card.eventId ?? 'hits'}>
            {hits.slice(0, MAX_ROWS).map((hit, i) => {
              const shown = hitDisplay(hit);
              const main = shown.isPrivate ? (
                <span className={styles.private}>Private memory</span>
              ) : shown.origin === 'memory' ? (
                `"${shown.text}"`
              ) : (
                shown.text
              );
              const score = typeof hit.score === 'number' && Number.isFinite(hit.score) ? `match ${hit.score.toFixed(2)}` : undefined;
              return <Row key={`${hit.id ?? 'hit'}:${i}`} main={main} side={score} meta={hitMeta(hit, shown.category)} />;
            })}
          </RowList>
          <More total={hits.length} />
        </>
      ) : (
        <Note card={card} waiting={['Recalling memory and web results', 'Still recalling']} />
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------------------------
// Claude drafted

const KIND_WORDS: Readonly<Record<OptionKind, string>> = {
  reply: 'Reply',
  errand: 'Errand',
  call: 'Call',
  menu: 'Menu',
};

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** "Calm tone, from Google Maps and the web", or "Sad tone, no sources". */
function optionMeta(option: AnswerOption): string {
  if (option.kind === 'menu') return "From the person's menu";
  const from = new Set<string>();
  for (const ref of Array.isArray(option.sources) ? option.sources : []) {
    const source = ref !== null && typeof ref === 'object' ? str(ref.source) : null;
    if (source === 'maps') from.add('Google Maps');
    else if (source === 'memory') from.add('memory');
    else from.add('the web');
  }
  const list = [...from];
  const sources =
    list.length === 0 ? 'no sources' : `from ${list.length === 1 ? list[0] : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`}`;
  const tone = str(option.tone);
  return tone ? `${capitalize(tone)} tone, ${sources}` : capitalize(sources);
}

function DraftView({ panel }: { panel: DraftPanel }) {
  const { card, options, pickedId } = panel;
  const drafting = card.status === 'working';
  // A failed or stopped draft keeps the earlier options on screen, under the sentence that says why.
  const showNote = !drafting && (card.status === 'failed' || card.status === 'stopped' || options.length === 0);
  const ms = finalMs(card);
  let meta: string | null = null;
  if (card.status === 'done' && options.length > 0) {
    const count = formatCount(options.length, panel.followUp ? 'follow-up option' : 'option');
    meta = ms === null ? count : `${count} in ${formatSeconds(ms)}`;
  }
  return (
    <Panel title="Claude drafted" meta={meta}>
      {drafting ? (
        <StatusLine
          messages={
            options.length > 0
              ? ['Drafting new options', 'Still drafting', 'Still drafting. Claude can take a few seconds.']
              : ['Drafting options', 'Still drafting', 'Still drafting. Claude can take a few seconds.']
          }
          resetKey={card.eventId ?? undefined}
          align="start"
          className={styles.wait}
        />
      ) : null}
      {showNote ? <Note card={card} waiting={['Drafting options']} /> : null}
      {options.length > 0 ? (
        <RowList label={drafting ? 'The options before this draft' : 'Options in reading order'} className={cx(styles.list, drafting && styles.stale)} key={options[0]?.version ?? 'options'}>
          {options.map((option) => {
            const picked = option.id === pickedId;
            return (
              <Row
                key={option.id}
                current={picked}
                main={
                  <>
                    <span className={cx(styles.rank, 'num')}>{option.rank}</span>
                    {str(option.text) ?? 'Option'}
                  </>
                }
                side={picked ? <span className={styles.picked}>Picked</span> : KIND_WORDS[option.kind] ?? 'Option'}
                meta={optionMeta(option)}
              />
            );
          })}
        </RowList>
      ) : null}
    </Panel>
  );
}
