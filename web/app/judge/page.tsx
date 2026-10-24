import type { Metadata } from 'next';
import { Judge } from '@/components/judge/Judge';

export const metadata: Metadata = { title: 'For judges' };

/** The judge page (PLAN 5.8): a three-minute itinerary, the public stats routes and what is verified. No login. */
export default function JudgePage() {
  return <Judge />;
}
