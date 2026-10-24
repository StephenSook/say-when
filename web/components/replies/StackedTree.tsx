'use client';

/**
 * The same tree as a list, for a phone (under 720 px): the question, each job with its results, then each round's
 * drafting, its options and what grew from the pick. Same cards, same words, no canvas.
 */
import type { ReplyTree, TreeNode } from '@/lib/tree/model';
import { Card } from './TreeCards';
import styles from './ReplyTree.module.css';

export function StackedTree({ tree }: { tree: ReplyTree }) {
  const cards = tree.nodes.filter((node) => node.kind !== 'region');
  const question = cards.find((node) => node.kind === 'question');
  const group = (region: 'notes' | 'web'): { hub: TreeNode | undefined; children: TreeNode[] } => ({
    hub: cards.find((node) => node.kind === 'hub' && node.job === region),
    children: cards.filter((node) => (node.kind === 'child' || node.kind === 'more') && node.region === region),
  });
  const rest = cards.filter((node) => node.kind === 'option' || node.kind === 'step' || (node.kind === 'hub' && node.job === 'draft'));
  return (
    <ol className={styles.stack} aria-label="Suggested replies, in order">
      {question ? (
        <li aria-label={question.ariaLabel}>
          <Card node={question} />
        </li>
      ) : null}
      {(['notes', 'web'] as const).map((region) => {
        const { hub, children } = group(region);
        if (!hub) return null;
        return (
          <li key={region} className={styles.stackGroup} aria-label={hub.ariaLabel}>
            <Card node={hub} />
            {children.length > 0 ? (
              <ul className={styles.stackChildren}>
                {children.map((child) => (
                  <li key={child.id}>
                    <Card node={child} />
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        );
      })}
      {rest.map((node) => (
        <li key={node.id} aria-label={node.ariaLabel}>
          <Card node={node} />
        </li>
      ))}
    </ol>
  );
}
