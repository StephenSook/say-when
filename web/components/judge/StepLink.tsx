'use client';

import Link from 'next/link';
import { ArrowRightIcon } from '@/components/ui/icons';
import { useHref } from '@/lib/data/provider';
import { keepUnits, type ItineraryStep } from './model';
import styles from './Judge.module.css';

/** One stop of the itinerary: the whole row is the link, and it keeps ?replay like the tabs do. */
export function StepLink({ step }: { step: ItineraryStep }) {
  const href = useHref(step.href);
  return (
    <li className={styles.stepItem}>
      <Link href={href} className={styles.step}>
        <span className={`${styles.stepNumber} num`} aria-hidden="true">
          {step.n}
        </span>
        <span className={styles.stepBody}>
          <span className={styles.stepTitle}>{step.title}</span>
          <span className={styles.stepLine}>{keepUnits(step.line)}</span>
        </span>
        <ArrowRightIcon size={16} className={styles.stepArrow} />
      </Link>
    </li>
  );
}
