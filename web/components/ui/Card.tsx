import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from '@/lib/cx';
import styles from './Card.module.css';

export interface CardProps extends HTMLAttributes<HTMLElement> {
  children: ReactNode;
  as?: 'article' | 'section' | 'div';
  /** The agent that is not working right now: drawn at 55% (docs/mockups/agents.html). */
  muted?: boolean;
  /** Rise 7 px and fade in over 160 ms when it first appears. */
  enter?: boolean;
  /** Inner padding. md is 24 px. */
  padding?: 'none' | 'sm' | 'md';
}

/** A raised panel: card background, 1 px border, panel radius, card shadow (docs/ui.md "Card"). */
export function Card({ children, as: Tag = 'div', muted = false, enter = false, padding = 'md', className, ...rest }: CardProps) {
  return (
    <Tag
      className={cx(styles.card, muted && styles.muted, enter && styles.enter, padding === 'sm' && styles.sm, padding === 'none' && styles.none, className)}
      {...rest}
    >
      {children}
    </Tag>
  );
}
