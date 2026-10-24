/**
 * The live microphone level behind the "Hold to ask" button. It opens the microphone only while the
 * button is held, measures how loud the input is on this phone, and closes everything on release.
 * Nothing is recorded, kept or sent: each block of samples is read for its loudness and dropped.
 *
 * Call start() from the press handler itself: iOS Safari lets an AudioContext run only when it is
 * created or resumed during a user gesture. When Cartesia Ink-2 push to talk is wired
 * (cartesia/README.md, `listen`), it opens its own capture; this meter stays the on-screen level.
 */

export type MicStatus =
  /** Not held. */
  | 'off'
  /** Waiting for the microphone, or for the permission prompt. */
  | 'starting'
  /** The microphone is open and the level is live. */
  | 'on'
  /** The person or the browser said no to the microphone. */
  | 'blocked'
  /** No microphone, or the page cannot use one (it needs HTTPS). */
  | 'unavailable';

export interface MicMeterCallbacks {
  /** 0 (silence) to 1 (loud), once a frame while the microphone is open, and 0 on stop. */
  onLevel(level: number): void;
  onStatus(status: MicStatus): void;
}

/** Quiet speech near the phone sits around -45 dBFS and loud speech around -12, so map that onto 0 to 1. */
const FLOOR_DB = -55;
const CEILING_DB = -12;

/** Loudness of one block of samples (its root mean square) on a 0 to 1 scale. */
export function levelFromRms(rms: number): number {
  if (!(rms > 0)) return 0;
  const db = 20 * Math.log10(rms);
  return Math.min(1, Math.max(0, (db - FLOOR_DB) / (CEILING_DB - FLOOR_DB)));
}

type AudioContextClass = typeof AudioContext;

function audioContextClass(): AudioContextClass | null {
  if (typeof window === 'undefined') return null;
  if (typeof AudioContext === 'function') return AudioContext;
  // Older Safari only has the prefixed name.
  return (window as Window & { webkitAudioContext?: AudioContextClass }).webkitAudioContext ?? null;
}

function errorName(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'name' in error) return String((error as { name: unknown }).name);
  return '';
}

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

export class MicMeter {
  /** Bumped on every start and stop, so a late permission answer from an old press is dropped. */
  private session = 0;
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private frame: number | null = null;

  constructor(private readonly callbacks: MicMeterCallbacks) {}

  /** Opens the microphone. Call it from the press handler. */
  start(): void {
    this.session++;
    this.release();
    const session = this.session;
    const Context = audioContextClass();
    const media = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices;
    if (!Context || !media || typeof media.getUserMedia !== 'function') {
      this.callbacks.onStatus('unavailable');
      return;
    }
    let context: AudioContext;
    try {
      context = new Context();
    } catch {
      this.callbacks.onStatus('unavailable');
      return;
    }
    this.context = context;
    void context.resume().catch(() => undefined);
    this.callbacks.onStatus('starting');

    media.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }).then(
      (stream) => {
        if (session !== this.session || this.context !== context) {
          // Let go before the microphone opened: close it at once.
          stopTracks(stream);
          return;
        }
        this.stream = stream;
        try {
          const source = context.createMediaStreamSource(stream);
          const analyser = context.createAnalyser();
          analyser.fftSize = 1024;
          // Not connected to the speakers: the partner should not hear themselves.
          source.connect(analyser);
          this.source = source;
          this.callbacks.onStatus('on');
          this.measure(session, analyser);
        } catch {
          this.release();
          this.callbacks.onStatus('unavailable');
        }
      },
      (error: unknown) => {
        if (session !== this.session) return;
        this.release();
        const name = errorName(error);
        this.callbacks.onStatus(name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError' ? 'blocked' : 'unavailable');
      },
    );
  }

  /** Closes the microphone and drops the level to 0. Safe to call at any time, more than once. */
  stop(): void {
    this.session++;
    this.release();
    this.callbacks.onLevel(0);
    this.callbacks.onStatus('off');
  }

  private measure(session: number, analyser: AnalyserNode): void {
    const samples = new Float32Array(analyser.fftSize);
    let level = 0;
    const tick = () => {
      if (session !== this.session) return;
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (let i = 0; i < samples.length; i++) {
        const value = samples[i] ?? 0;
        sum += value * value;
      }
      const target = levelFromRms(Math.sqrt(sum / samples.length));
      // Rise fast and fall slowly, so the bars follow speech without flicker.
      level += (target - level) * (target > level ? 0.6 : 0.12);
      this.callbacks.onLevel(level);
      this.frame = requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
  }

  private release(): void {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    try {
      this.source?.disconnect();
    } catch {
      // Already disconnected.
    }
    this.source = null;
    if (this.stream) stopTracks(this.stream);
    this.stream = null;
    const context = this.context;
    this.context = null;
    if (context && context.state !== 'closed') void context.close().catch(() => undefined);
  }
}
