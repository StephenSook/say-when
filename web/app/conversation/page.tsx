import type { Metadata } from 'next';
import { Conversation } from '@/components/screens/Conversation';

export const metadata: Metadata = { title: 'Conversation' };

export default function ConversationPage() {
  return <Conversation />;
}
