import type { Metadata } from 'next';
import { EegQuiz } from '@/components/eeg/EegQuiz';

export const metadata: Metadata = { title: 'Quiz' };

/**
 * A true or false practice quiz answered with the headset (right fist = TRUE, left fist = FALSE), with the decoder's live left, right
 * and rest bars. Open it on the EEG laptop while eeg-data/live.py runs; it reads only ws://127.0.0.1:8765. The live
 * brain itself is Screen 1 at /brain.
 */
export default function QuizPage() {
  return <EegQuiz />;
}
