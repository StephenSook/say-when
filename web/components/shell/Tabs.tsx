'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cx } from '@/lib/cx';
import { useReplayParam } from '@/lib/data/provider';
import { withReplayParam } from '@/lib/data/source-mode';
import styles from './Tabs.module.css';

/** The dashboard screens in PLAN order. Keys 1, 2 and 3 switch between them; 5 opens Suggested replies. */
export const TABS = [
  { href: '/live', label: 'Live data', key: '1' },
  { href: '/agents', label: 'Agents', key: '2' },
  { href: '/conversation', label: 'Conversation', key: '3' },
  { href: '/replies', label: 'Replies', key: '5' },
] as const;

export function isCurrentTab(pathname: string | null, href: string): boolean {
  if (!pathname) return false;
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function Tabs({ className }: { className?: string }) {
  const pathname = usePathname();
  const replayParam = useReplayParam();
  return (
    <nav className={cx(styles.tabs, className)} aria-label="Screens">
      {TABS.map((tab) => {
        const current = isCurrentTab(pathname, tab.href);
        return (
          <Link
            key={tab.href}
            href={withReplayParam(tab.href, replayParam)}
            className={cx(styles.tab, current && styles.current)}
            aria-current={current ? 'page' : undefined}
            aria-keyshortcuts={tab.key}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
