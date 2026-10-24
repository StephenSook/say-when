'use client';

/**
 * Loads Screen 1 in the browser only: the 3D scene needs WebGL and the charts need a window, so nothing of it renders
 * on the server.
 */
import dynamic from 'next/dynamic';

const BrainScreen = dynamic(() => import('./BrainScreen'), {
  ssr: false,
  loading: () => <p>Loading the brain view.</p>,
});

export function BrainPage() {
  return <BrainScreen />;
}
