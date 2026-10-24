import type { Metadata } from 'next';
import { Partner } from '@/components/screens/Partner';

export const metadata: Metadata = { title: 'Partner' };

/** The partner's phone view. No dashboard header: components/shell/Shell.tsx skips it for /partner. */
export default function PartnerPage() {
  return <Partner />;
}
