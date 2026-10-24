'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { cx } from '@/lib/cx';
import { useHref } from '@/lib/data/provider';
import styles from './TextLink.module.css';

interface Common {
  children: ReactNode;
  title?: string;
  className?: string;
}

export type TextLinkProps =
  | (Common & {
      /** An in-app path such as "/agents" (keeps ?replay), or a full https:// address (opens a new tab). */
      href: string;
      onClick?: never;
      pressed?: never;
    })
  | (Common & {
      href?: undefined;
      onClick: () => void;
      /** For toggles such as Pause on the event feed. */
      pressed?: boolean;
    });

/** A quiet text action: muted, full color on hover and focus (docs/ui.md "Text link"). */
export function TextLink(props: TextLinkProps) {
  if (props.href !== undefined) return <AnchorLink {...props} href={props.href} />;
  const { children, title, className, onClick, pressed } = props;
  return (
    <button type="button" className={cx(styles.link, className)} onClick={onClick} title={title} aria-pressed={pressed}>
      {children}
    </button>
  );
}

function AnchorLink({ href, children, title, className }: Common & { href: string }) {
  const internal = useHref(href);
  if (href.startsWith('/')) {
    return (
      <Link href={internal} className={cx(styles.link, className)} title={title}>
        {children}
      </Link>
    );
  }
  return (
    <a href={href} className={cx(styles.link, className)} title={title} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}
