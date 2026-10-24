/**
 * The last commands on the station screen (docs/station.md 2.2): time, command, where it came from (key, switch,
 * imagery, jaw), and what the module did with it. An ignored command is muted, never red: the debounce working is
 * not a failure (docs/ui.md). The status is an icon and a color beside the words.
 */
import { StatusMark } from '@/components/ui/StatusMark';
import { cx } from '@/lib/cx';
import { formatClock } from '@/lib/format';
import type { CommandEntry } from '@/lib/station/commands';
import { commandRows } from '@/lib/station/model';
import styles from './CommandList.module.css';

export function CommandList({ commands }: { commands: readonly CommandEntry[] }) {
  const rows = commandRows(commands);
  return (
    <section className={styles.wrap} aria-labelledby="last-commands">
      <h2 id="last-commands" className={styles.label}>
        Last commands
      </h2>
      {rows.length === 0 ? (
        <p className={styles.empty}>No commands yet.</p>
      ) : (
        <ol className={styles.list}>
          {rows.map((row, i) => (
            <li key={row.key} className={cx(styles.row, styles[row.status])} title={row.title ?? undefined}>
              <span className={cx(styles.time, 'num')}>{formatClock(commands[i]!.at)}</span>
              <span className={styles.command}>{row.command}</span>
              <span className={styles.source}>{row.source}</span>
              <span className={styles.words}>
                <StatusMark status={row.status} showWord={false} />
                <span>{row.words}</span>
                {row.note ? <span className={styles.source}>{row.note}</span> : null}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
