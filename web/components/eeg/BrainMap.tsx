import { changeColor, type EegChannel } from '@/lib/eeg/live';
import styles from './EegQuiz.module.css';

/** Where the 8 electrodes sit before the first frame arrives (the decoder sends the same positions). */
export const DEFAULT_CHANNELS: EegChannel[] = [
  ['FC4', 0.521, 0.198], ['C4', 0.515, -0.084], ['CP4', 0.465, -0.326], ['C2', 0.256, -0.065],
  ['C1', -0.243, -0.067], ['CP3', -0.449, -0.332], ['C3', -0.502, -0.089], ['FC3', -0.511, 0.193],
].map(([name, x, y]) => ({ name: name as string, x: x as number, y: y as number, change: 0, flat: false, noisy: false }));

/**
 * The head from above with the 8 electrodes over the hand areas. Each electrode is filled by its change against the
 * resting level: blue when power dropped (that area is working), red when it rose. When one hand area clearly drops
 * more than the other it glows: the left hemisphere (C3 side) moves the right hand.
 */
export function BrainMap({ channels, activeHand, live }: { channels: EegChannel[]; activeHand: 'left' | 'right' | null; live: boolean }) {
  const glowX = activeHand === 'right' ? -0.42 : 0.42;
  return (
    <svg className={styles.map} viewBox="-1.3 -1.35 2.6 2.62" role="img" aria-label="Electrode map, head seen from above">
      <defs>
        <radialGradient id="eeg-glow">
          <stop offset="0%" stopColor="rgba(96, 160, 255, 0.55)" />
          <stop offset="100%" stopColor="rgba(96, 160, 255, 0)" />
        </radialGradient>
      </defs>
      <circle cx={0} cy={0} r={1} className={styles.head} />
      <path d="M -0.12 -0.99 L 0 -1.13 L 0.12 -0.99" className={styles.headLine} />
      <path d="M -1 -0.14 Q -1.1 0 -1 0.14" className={styles.headLine} />
      <path d="M 1 -0.14 Q 1.1 0 1 0.14" className={styles.headLine} />
      <line x1={0} y1={-1} x2={0} y2={1} className={styles.midline} />
      {live && activeHand ? <circle cx={glowX} cy={0.05} r={0.42} fill="url(#eeg-glow)" /> : null}
      <text x={-1.25} y={-1.18} className={styles.mapLabel}>Left side (right hand)</text>
      <text x={1.25} y={-1.18} className={styles.mapLabel} textAnchor="end">Right side (left hand)</text>
      {channels.map((c) => {
        const ring = c.flat ? styles.dotOff : c.noisy ? styles.dotNoisy : styles.dot;
        const note = !live ? '' : c.flat ? 'off' : c.noisy ? 'noisy' : `${c.change > 0 ? '+' : ''}${Math.round(c.change)}%`;
        return (
          <g key={c.name}>
            <circle cx={c.x} cy={-c.y} r={0.085} className={ring} fill={live && !c.flat ? changeColor(c.change) : 'transparent'} />
            <text x={c.x} y={-c.y + 0.02} className={styles.dotName} textAnchor="middle">{c.name}</text>
            <text x={c.x} y={-c.y + 0.15} className={styles.dotNote} textAnchor="middle">{note}</text>
          </g>
        );
      })}
    </svg>
  );
}
