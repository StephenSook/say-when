import type { Metadata } from 'next';
import { Speaker } from '@/components/speaker/Speaker';

export const metadata: Metadata = { title: 'Room voice' };

/** The room voice (docs/station.md 3): paired as the Speaker, it says each released reply once, aloud. */
export default function SpeakerPage() {
  return <Speaker />;
}
