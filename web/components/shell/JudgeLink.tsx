'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cx } from '@/lib/cx';
import { useReplayParam } from '@/lib/data/provider';
import { withReplayParam } from '@/lib/data/source-mode';
import { isJudgeRoute } from '@/lib/routes';
import styles from './JudgeLink.module.css';

/** The quiet way to the judge page (PLAN 5.8): smaller and dimmer than the tabs, so it is not a fourth screen. */
export function JudgeLink({ className }: { className?: string }) {
  const pathname = usePathname();
  const replayParam = useReplayParam();
  const current = isJudgeRoute(pathname);
  return (
    <Link
      href={withReplayParam('/judge', replayParam)}
      className={cx(styles.link, current && styles.current, className)}
      aria-current={current ? 'page' : undefined}
    >
      For judges
    </Link>
  );
}
