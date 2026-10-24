import type { Metadata } from 'next';
import { LiveData } from '@/components/screens/LiveData';

export const metadata: Metadata = { title: 'Live data' };

export default function LivePage() {
  return <LiveData />;
}
