import type { Metadata } from 'next';
import { BrainPage } from '@/components/brain/BrainPage';

export const metadata: Metadata = { title: 'Brain' };

/** Screen 1, the live brain: reads the local EEG bridge on 127.0.0.1:8766 only, never SpacetimeDB. */
export default function Page() {
  return <BrainPage />;
}
