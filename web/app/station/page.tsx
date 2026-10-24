import type { Metadata } from 'next';
import { Station } from '@/components/station/Station';

export const metadata: Metadata = { title: 'Station' };

/**
 * The station (docs/station.md 2): Chrome on the EEG laptop with a wired earpiece. It pairs as the Station role,
 * relays the person's commands to the module and plays the scan into the earpiece. The wearer never looks at this
 * screen; it is for the operator and the judges.
 */
export default function StationPage() {
  return <Station />;
}
