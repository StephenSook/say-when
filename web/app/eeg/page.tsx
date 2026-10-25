import type { Metadata } from 'next';
import { EegQuiz } from '@/components/eeg/EegQuiz';

export const metadata: Metadata = { title: 'Headset' };

/**
 * The headset page: the decoder's live signal (electrode map, left, right and rest bars, jaw level) and a true or false
 * practice quiz. Open it on the EEG laptop while eeg-data/live.py runs; it reads only ws://127.0.0.1:8765.
 */
export default function EegPage() {
  return <EegQuiz />;
}
