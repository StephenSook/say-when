'use client';

/**
 * The command strip (docs/ui.md "Command strip"): the person's four commands at the bottom center,
 * a legend and a live echo of the headset. When a command event arrives, its chip lights for 1.2 s
 * (litCommand): accent border and fill, and its light turns from a ring into a filled dot, so the
 * echo is a shape as well as a color. Ignored repeats never light. HEADSET_OFF is a system event,
 * not a command the person gives, so it has no chip; the shell banner shows it.
 */
import { Chip } from '@/components/ui/Chip';
import { COMMAND_INFO, commandChipLabel } from '@/lib/commands';
import { cx } from '@/lib/cx';
import { litCommand } from '@/lib/data/derive';
import { useCommands } from '@/lib/data/provider';
import { PERSON_COMMANDS } from '@/lib/data/types';
import { useNow } from '@/lib/use-now';
import styles from './CommandStrip.module.css';

export function CommandStrip() {
  const commands = useCommands();
  const now = useNow(250);
  const lit = now > 0 ? litCommand(commands, now) : null;

  return (
    <ul className={styles.strip} aria-label="Headset commands. The last one heard lights up.">
      {PERSON_COMMANDS.map((name) => {
        const on = lit === name;
        return (
          <li key={name} className={styles.item}>
            <Chip size="lg" lit={on} lead={<span className={cx(styles.light, on && styles.on)} />} title={COMMAND_INFO[name].meaning}>
              {commandChipLabel(name)}
              {on ? <span className="visually-hidden">, just heard</span> : null}
            </Chip>
          </li>
        );
      })}
    </ul>
  );
}
