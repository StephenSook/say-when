import type { Metadata } from 'next';
import { Stage } from '@/components/stage/Stage';

export const metadata: Metadata = { title: 'Stage' };

/** The projector screen for the live demo: the whole loop on one screen (components/stage/Stage.tsx). Not a tab. */
export default function StagePage() {
  return <Stage />;
}
