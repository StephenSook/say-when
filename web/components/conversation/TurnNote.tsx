'use client';

/**
 * The one line that says where a turn is when it is not being read: listening, drafting, getting
 * the voice ready, an error, or how a turn ended without a pick. Each wait uses the status line
 * (0, 3 and 10 s messages); an error is the failed mark plus one sentence, raw text in a tooltip.
 */
import { StatusLine } from '@/components/ui/StatusLine';
import { StatusMark } from '@/components/ui/StatusMark';
import type { Ending, TurnNote as TurnNoteView } from './model';
import styles from './TurnNote.module.css';

export interface TurnNoteProps {
  note: TurnNoteView;
  /** Restarts the 0, 3 and 10 s messages, for example on a new question. */
  resetKey: string;
}

export function TurnNote({ note, resetKey }: TurnNoteProps) {
  const key = `${resetKey}:${note.kind}`;
  switch (note.kind) {
    case 'listening':
      return (
        <div className={styles.big}>
          <StatusLine messages={['Listening to the partner', 'Still listening']} resetKey={key} size="lead" align="start" />
        </div>
      );
    case 'drafting':
      return (
        <div className={styles.big}>
          <StatusLine
            messages={['Drafting options', 'Still drafting options', 'Still drafting. This can take a few more seconds.']}
            resetKey={key}
            size="lead"
            align="start"
          />
        </div>
      );
    case 'drafting-more':
      return (
        <div className={styles.small}>
          <StatusLine messages={['Drafting more options', 'Still drafting more options']} resetKey={key} align="start" />
        </div>
      );
    case 'preparing':
      return (
        <div className={styles.small}>
          <StatusLine messages={['Getting ready to read the options', 'Still getting the voice ready']} resetKey={key} align="start" />
        </div>
      );
    case 'no-options':
      return (
        <p className={styles.quiet} role="status">
          No options yet.
        </p>
      );
    case 'error':
      return (
        <p className={styles.error} role="alert" title={note.raw ?? undefined}>
          <StatusMark status="failed" showWord={false} />
          <span>{note.sentence}</span>
        </p>
      );
  }
}

/** How a turn ended without a pick: "None of these. Nothing was said or sent." Muted, never red. */
export function TurnEnding({ ending }: { ending: Ending }) {
  return (
    <p className={styles.ending}>
      <StatusMark status="stopped" showWord={false} />
      <span>{ending.sentence}</span>
    </p>
  );
}
