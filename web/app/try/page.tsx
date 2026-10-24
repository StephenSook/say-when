import type { Metadata } from 'next';
import { TryPage } from '@/components/try/TryPage';

export const metadata: Metadata = { title: 'Try it' };

/**
 * The judge try sandbox (PLAN 5.11): Eleven on the say-when-try database, from any phone or laptop, with on-screen
 * buttons standing in for the headset. It pairs as a Station on its own; the module's sandbox ties the try to it.
 */
export default function TryRoute() {
  return <TryPage />;
}
