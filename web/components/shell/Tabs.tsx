'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cx } from '@/lib/cx';
import { useReplayParam } from '@/lib/data/provider';
import { withReplayParam } from '@/lib/data/source-mode';
import styles from './Tabs.module.css';

/** The dashboard screens in PLAN order, then the live brain (Screen 1). Keys 1 to 4 switch between them. */
export const TABS = [
  { href: '/live', label: 'Live data', key: '1' },
  { href: '/agents', label: 'Agents', key: '2' },
  { href: '/conversation', label: 'Conversation', key: '3' },
  { href: '/brain', label: 'Brain', key: '4' },
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
