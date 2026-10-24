import type { Metadata } from 'next';
import { Agents } from '@/components/screens/Agents';

export const metadata: Metadata = { title: 'Agents' };

export default function AgentsPage() {
  return <Agents />;
}
