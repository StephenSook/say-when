'use client';

/**
 * The strip under the brain: one row per band of the decoder's filter bank (Mu 8-12 Hz through High beta 26-30 Hz,
 * then the slow potential), each a plain line over the last 20 s for C3 (cyan) and C4 (amber) against a dashed rest
 * line, with the latest value at the right end. Then the decoder's guesses as pills on the same time axis, and the
 * jaw muscle lane, which is muscle and never brain. A jaw clench lights up the 20 to 30 Hz bands, so its moments are
 * shaded on every row.
 *
 * Labels and values are DOM; the lines are one canvas drawn in requestAnimationFrame from stream.state, only when
 * the data changed. With no filter bank from an older bridge, the rows fall back to its mu and beta values.
 */
import { useEffect, useRef } from 'react';
import { cx } from '@/lib/cx';
import { AMBER, CYAN, LABELS, eventPillText, isJawCommand, pctText } from '@/lib/brain/model';
import type { VizState, VizStream } from '@/lib/brain/stream';
import styles from './BandStrip.module.css';

/** Seconds of history on screen. */
export const WINDOW_S = 20;
/** One scale for every band row, so rows compare: -60% to +40% change from rest. */
const Y_MIN = -60;
const Y_MAX = 40;
/** Jaw level scale, microvolts RMS. */
const EMG_MAX = 150;

interface Row {
  key: string;
  name: string;
  hz: string;
  /** Draws thicker: it drives the glow. */
  main: boolean;
  /** After a small gap: a different kind of feature. */
  apart: boolean;
  series: (state: VizState, side: 'c3' | 'c4') => number[];
  latest: (state: VizState, side: 'c3' | 'c4') => number | null;
}

/** "Mu 8-12 Hz" into "Mu" and "8-12 Hz". */
export function splitLabel(label: string): { name: string; hz: string } {
  const m = /^(.*?)\s+([\d.]+-[\d.]+\s*Hz)$/.exec(label.trim());
  return m ? { name: m[1], hz: m[2] } : { name: label, hz: '' };
}

function rowsFor(state: VizState): Row[] {
  const bank = state.meta?.filterBank ?? null;
  if (bank && bank.length) {
    const rows = bank.map((band, index): Row => {
      const { name, hz } = splitLabel(band.label);
      return {
        key: band.id,
        name,
        hz,
        main: band.id === 'b8_12',
        apart: band.id === 'mrcp',
        series: (s, side) => (s.history.bandCount > index ? s.history.bandSeries(side, index) : []),
        latest: (s, side) => s.mi?.fb?.[side]?.[index] ?? null,
      };
    });
    // The slow potential is a different kind of feature: it goes last, after a gap.
    return [...rows.filter((r) => !r.apart), ...rows.filter((r) => r.apart)];
  }
  const mu = state.meta?.bands.alphaMu ?? [8, 13];
  const beta = state.meta?.bands.beta ?? [13, 30];
  return [
    {
      key: 'mu',
      name: 'Mu',
      hz: `${mu[0]}-${mu[1]} Hz`,
      main: true,
      apart: false,
      series: (s, side) => s.history.ordered(side === 'c3' ? s.history.c3mu : s.history.c4mu),
      latest: (s, side) => s.mi?.[side].mu ?? null,
    },
    {
      key: 'beta',
      name: 'Beta',
      hz: `${beta[0]}-${beta[1]} Hz`,
      main: false,
      apart: false,
      series: (s, side) => s.history.ordered(side === 'c3' ? s.history.c3beta : s.history.c4beta),
      latest: (s, side) => s.mi?.[side].beta ?? null,
    },
  ];
}

export interface BandStripProps {
  stream: VizStream;
  /** True while the readings may be shown (measuring); otherwise the values column stays empty. */
  live: boolean;
}

export function BandStrip({ stream, live }: BandStripProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const state = stream.state;
  const rows = rowsFor(state);
  const badContact = Object.entries(state.quality?.contact ?? {}).filter(([, c]) => c === 'poor' || c === 'off');
  const rowKeys = rows.map((r) => r.key).join(',');

  useEffect(() => {
    const root = rootRef.current;
    const canvas = canvasRef.current;
    if (!root || !canvas) return;
    let raf = 0;
    let drawnVersion = -1;
    let drawnSize = '';
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const s = stream.state;
      const size = `${root.clientWidth}x${root.clientHeight}`;
      if (s.version === drawnVersion && size === drawnSize) return;
      drawnVersion = s.version;
      drawnSize = size;
      paint(root, canvas, s, rowsFor(s));
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [stream, rowKeys]);

  return (
    <div ref={rootRef} className={styles.strip}>
      <canvas ref={canvasRef} className={styles.canvas} aria-hidden="true" />
      <div className={styles.legend}>
        <span className={styles.key}>
          <span className={styles.swatch} style={{ background: 'var(--c3)' }} aria-hidden="true" />
          {LABELS.legendC3}
        </span>
        <span className={styles.key}>
          <span className={styles.swatch} style={{ background: 'var(--c4)' }} aria-hidden="true" />
          {LABELS.legendC4}
        </span>
        {badContact.map(([name, c]) => (
          <span key={name} className={styles.bad}>
            {name} {c === 'off' ? 'no contact' : 'poor contact'}
          </span>
        ))}
      </div>
      {rows.map((row) => {
        const c3 = live ? row.latest(state, 'c3') : null;
        const c4 = live ? row.latest(state, 'c4') : null;
        return (
          <div key={row.key} className={cx(styles.row, row.apart && styles.apart)} data-plot-row={row.key}>
            <span className={cx(styles.name, row.main && styles.main)}>
              {row.name} <span className={styles.hz}>{row.hz}</span>
            </span>
            <span className={styles.plot} data-plot />
            <span className={styles.values}>
              <span className={styles.c3}>{c3 === null ? '' : pctText(c3)}</span>
              <span className={styles.c4}>{c4 === null ? '' : pctText(c4)}</span>
            </span>
          </div>
        );
      })}
      <div className={cx(styles.row, styles.lane)} data-plot-row="guesses">
        <span className={styles.name}>Decoder guesses</span>
        <span className={styles.plot} data-plot />
        <span className={styles.values} />
      </div>
      <div className={cx(styles.row, styles.lane)} data-plot-row="jaw">
        <span className={styles.name}>{LABELS.jawLane}</span>
        <span className={styles.plot} data-plot />
        <span className={styles.values}>
          <span className={styles.muted}>{state.mi?.emgGate ? 'Muscle' : ''}</span>
        </span>
      </div>
      <div className={styles.axis}>
        <span />
        <span className={styles.axisEnds}>
          <span>{'−'}20 s</span>
          <span>now</span>
        </span>
        <span />
      </div>
    </div>
  );
}

/* ---------- Drawing ---------- */

function cssVar(el: Element, name: string, fallback: string): string {
  return getComputedStyle(el).getPropertyValue(name).trim() || fallback;
}

function paint(root: HTMLDivElement, canvas: HTMLCanvasElement, s: VizState, rows: Row[]) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = root.clientWidth;
  const h = root.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const rootBox = root.getBoundingClientRect();
  const fg = cssVar(root, '--fg', 'rgba(255,255,255,0.88)');
  const font = getComputedStyle(root).fontFamily;
  const t = s.history.ordered(s.history.t);
  const tEnd = t.length ? t[t.length - 1] : 0;
  const tStart = tEnd - WINDOW_S;
  const gate = s.history.ordered(s.history.gate as unknown as Float32Array);

  const plots = new Map<string, DOMRect>();
  root.querySelectorAll<HTMLElement>('[data-plot-row]').forEach((rowEl) => {
    const cell = rowEl.querySelector<HTMLElement>('[data-plot]');
    if (cell) plots.set(rowEl.dataset.plotRow ?? '', cell.getBoundingClientRect());
  });

  const frame = (key: string) => {
    const r = plots.get(key);
    if (!r) return null;
    const x0 = r.left - rootBox.left;
    const y0 = r.top - rootBox.top;
    return { x0, y0, w: r.width, h: r.height, X: (tt: number) => x0 + ((tt - tStart) / WINDOW_S) * r.width };
  };

  // Muscle moments, shaded on every row: the 20 to 30 Hz bands light up with the jaw, and that is not brain.
  const shadeGate = (f: NonNullable<ReturnType<typeof frame>>, alpha: number) => {
    if (!t.length) return;
    ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
    for (let i = 0; i < t.length; i++) {
      if (!gate[i] || t[i] < tStart) continue;
      const next = i + 1 < t.length ? t[i + 1] : t[i] + 0.1;
      ctx.fillRect(f.X(t[i]), f.y0, Math.max(1, f.X(next) - f.X(t[i])), f.h);
    }
  };

  const line = (f: NonNullable<ReturnType<typeof frame>>, ys: number[], color: string, width: number, toY: (v: number) => number) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    let pen = false;
    for (let i = 0; i < ys.length && i < t.length; i++) {
      const v = ys[i];
      if (!Number.isFinite(v) || t[i] < tStart) {
        pen = false;
        continue;
      }
      const x = f.X(t[i]);
      const y = toY(v);
      if (pen) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
      pen = true;
    }
    ctx.stroke();
  };

  for (const row of rows) {
    const f = frame(row.key);
    if (!f) continue;
    const pad = 4;
    const toY = (v: number) => f.y0 + pad + ((Y_MAX - Math.max(Y_MIN, Math.min(Y_MAX, v))) / (Y_MAX - Y_MIN)) * (f.h - 2 * pad);
    shadeGate(f, 0.07);
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.24)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(f.x0, toY(0));
    ctx.lineTo(f.x0 + f.w, toY(0));
    ctx.stroke();
    ctx.setLineDash([]);
    if (s.meta?.baseline.state !== 'set') continue;
    line(f, row.series(s, 'c4'), AMBER, row.main ? 3 : 2, toY);
    line(f, row.series(s, 'c3'), CYAN, row.main ? 3 : 2, toY);
  }

  const pill = (x: number, yMid: number, text: string, border: string, fill: string, maxX: number) => {
    ctx.font = `500 14px ${font}`;
    const tw = ctx.measureText(text).width;
    const pw = tw + 20;
    const ph = 24;
    const px = Math.min(Math.max(x - pw / 2, 0), maxX - pw);
    const py = yMid - ph / 2;
    ctx.beginPath();
    ctx.roundRect(px, py, pw, ph, ph / 2);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = border;
    ctx.stroke();
    ctx.fillStyle = fg;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, px + 10, yMid + 1);
  };

  const guesses = frame('guesses');
  const jaw = frame('jaw');
  if (jaw) {
    shadeGate(jaw, 0.24);
    const emg = s.history.ordered(s.history.emg);
    const threshold = s.mi?.emgThreshold ?? null;
    const toY = (v: number) => jaw.y0 + 3 + (1 - Math.min(Math.max(v, 0), EMG_MAX) / EMG_MAX) * (jaw.h - 6);
    if (threshold !== null) {
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.24)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(jaw.x0, toY(threshold));
      ctx.lineTo(jaw.x0 + jaw.w, toY(threshold));
      ctx.stroke();
      ctx.setLineDash([]);
    }
    line(jaw, emg, 'rgba(255, 255, 255, 0.52)', 2, toY);
  }
  for (const m of s.markers) {
    if (m.t < tStart || m.t > tEnd + 1) continue;
    if (isJawCommand(m.command) && jaw) {
      pill(jaw.X(m.t), jaw.y0 + jaw.h / 2, eventPillText(m), 'rgba(255, 255, 255, 0.6)', 'rgba(5, 5, 5, 0.85)', jaw.x0 + jaw.w);
    } else if ((m.command === 'YES' || m.command === 'NO') && guesses) {
      const imagery = m.source === 'imagery';
      const hue = m.command === 'YES' ? CYAN : AMBER;
      pill(guesses.X(m.t), guesses.y0 + guesses.h / 2, eventPillText(m), imagery ? hue : 'rgba(255, 255, 255, 0.4)', 'rgba(5, 5, 5, 0.85)', guesses.x0 + guesses.w);
    }
  }
}
