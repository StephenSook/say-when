import { cx } from '@/lib/cx';
import type { Header } from './model';
import styles from './TurnHeader.module.css';

/** "The partner asked" over the question in the partner's words (docs/mockups/conversation.html). */
export function TurnHeader({ header }: { header: Header }) {
  return (
    <div className={styles.header}>
      <p className={styles.eyebrow}>{header.eyebrow}</p>
      <h2 className={cx(styles.lead, !header.quoted && styles.standIn)}>{header.quoted ? `"${header.lead}"` : header.lead}</h2>
    </div>
  );
}
