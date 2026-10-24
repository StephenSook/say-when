import type { Metadata } from 'next';
import { Replies } from '@/components/screens/Replies';

export const metadata: Metadata = { title: 'Suggested replies' };

export default function RepliesPage() {
  return <Replies />;
}
