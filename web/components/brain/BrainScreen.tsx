'use client';

/**
 * Screen 1, the live brain, laid out like Screen 2 (/replies): a compact title row with one mode pill, then the stage
 * from edge to edge of the window, then the band strip. The brain is the focus: two soft patches under C3 and C4 glow
 * only as the 8-12 Hz rhythm at that electrode quiets against the wearer's own rest baseline, cyan on the
 * right-fist side and amber on the left-fist side. The stage carries only a state line when something needs
 * attention and the decoder's latest guess; everything else is in the info dialog (docs/ui.md rule zero).
 *
 * It reads only the local bridge on ws://127.0.0.1:8766. It never opens the station's channel and never touches
 * SpacetimeDB, so no EEG leaves this laptop.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Chip, CrossIcon, Dialog, ReplayIcon, StatusMark, TextLink } from '@/components/ui';
import { cx } from '@/lib/cx';
import { GUESS_SHOW_MS, LABELS, bridgeUrlFrom, buildBrainView, caption, guessText, isJawMarker, pulseSide, sceneFailedText, shouldAutoConnect, sourceText } from '@/lib/brain/model';
import { DEFAULT_VIZ_URL } from '@/lib/brain/protocol';
import { brainInputOf } from '@/lib/brain/stream';
import { useVizStream } from '@/lib/brain/useVizStream';
import { BandStrip } from './BandStrip';
import BrainScene from './BrainScene';
import styles from './BrainScreen.module.css';

/** Short credit on the stage; the full line is in the info dialog (tools/brain-asset/README.md). */
export const MODEL_CREDIT_SHORT = 'Brain model: Human Reference Atlas (HuBMAP),';
export const MODEL_TITLE = '3D Reference Organ for Brain, Male';
export const MODEL_DOI = 'https://doi.org/10.48539/HBM929.XKCL.339';
export const LICENSE_URL = 'https://creativecommons.org/licenses/by/4.0/';

/** One empty list for every render without meta, so the scene's raycasts and material are not rebuilt each time. */
const NO_CHANNELS: string[] = [];

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return reduced;
}

interface PageOptions {
  wearer: string | null;
  bloom: boolean;
  /** Open the local decoder without a click: on the EEG laptop's own server, or with ?bridge=1. */
  autoConnect: boolean;
  /** ws://127.0.0.1:8766, or a forwarded bridge from ?bridge=wss://... */
  vizUrl: string;
}

/**
 * ?wearer=Name personalizes the caption in the info dialog; ?bloom=0 turns the glow pass off on a slow laptop;
 * ?bridge=1 connects to the local decoder on a non-local host; ?bridge=wss://host connects to a forwarded bridge.
 */
function usePageOptions(): PageOptions {
  const [options, setOptions] = useState<PageOptions>({ wearer: null, bloom: true, autoConnect: false, vizUrl: DEFAULT_VIZ_URL });
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setOptions({
      wearer: params.get('wearer')?.trim().slice(0, 40) || null,
      bloom: params.get('bloom') !== '0',
      autoConnect: shouldAutoConnect(window.location.hostname, window.location.search),
      vizUrl: bridgeUrlFrom(window.location.search) ?? DEFAULT_VIZ_URL,
    });
  }, []);
  return options;
}

export default function BrainScreen() {
  const { wearer, bloom, autoConnect, vizUrl } = usePageOptions();
  const { stream, now, started, connect } = useVizStream(autoConnect, vizUrl);
  const reducedMotion = useReducedMotion();
  const [infoOpen, setInfoOpen] = useState(false);
  const [turned, setTurned] = useState(false);
  const resetRef = useRef<(() => void) | null>(null);
  const onTurned = useCallback(() => setTurned(true), []);

  const s = stream.state;
  const view = buildBrainView(brainInputOf(s, now, !started));
  const channelsKey = (s.meta?.channels ?? NO_CHANNELS).join(',');
  const channels = useMemo(() => (channelsKey ? channelsKey.split(',') : NO_CHANNELS), [channelsKey]);
  const source = s.meta?.source ?? null;

  const last = s.markers.length - 1;
  const marker = last >= 0 && now - s.markerAt[last] < GUESS_SHOW_MS && !isJawMarker(s.markers[last]) && s.markers[last].command !== 'HEADSET_OFF' ? s.markers[last] : null;
  const guessSide = marker && marker.source === 'imagery' ? pulseSide(marker) : null;

  const mode = view.mode;
  const modePill =
    mode.kind === 'live' ? (
      <Chip size="lg" tone="live" lead="dot">
        {mode.text}
      </Chip>
    ) : mode.kind === 'replay' ? (
      <Chip size="lg" dashed lead={<ReplayIcon />}>
        {mode.text}
      </Chip>
    ) : mode.kind === 'synthetic' ? (
      <Chip size="lg" dashed>
        {mode.text}
      </Chip>
    ) : (
      <Chip size="lg" tone="error" lead={<CrossIcon />}>
        {mode.text}
      </Chip>
    );

  const contact = Object.entries(s.quality?.contact ?? {});

  return (
    <div className={styles.root}>
      <div className={styles.head}>
        <div className={styles.titles}>
          <h1 className={styles.title}>{LABELS.title}</h1>
          <p className={styles.subtitle}>{LABELS.subtitle}</p>
          <button type="button" className={styles.info} onClick={() => setInfoOpen(true)} aria-label="About this view">
            <span aria-hidden="true">i</span>
          </button>
        </div>
        {modePill}
      </div>

      <section className={styles.stage} aria-label="Template brain with the C3 and C4 patches">
        <BrainScene
          stream={stream}
          channels={channels}
          c3Text={view.c3.valueText}
          c4Text={view.c4.valueText}
          reducedMotion={reducedMotion}
          bloom={bloom}
          onTurned={onTurned}
          resetRef={resetRef}
          failedText={sceneFailedText(source)}
        />
        <div className={styles.state} role="status" aria-live="polite">
          {view.stateLine ? (
            <span className={styles.stateLine} title={view.stateLine.detail}>
              <StatusMark status={view.stateLine.status} word={view.stateLine.text} />
              {view.needsBaseline ? <TextLink onClick={() => stream.recordBaseline()}>Record</TextLink> : null}
            </span>
          ) : null}
          {view.canConnect ? (
            <button type="button" className={styles.connect} onClick={connect}>
              Connect
            </button>
          ) : null}
          {source === 'synthetic' ? <p className={styles.synthetic}>{LABELS.synthetic}</p> : null}
        </div>
        {marker ? (
          <p className={cx(styles.guess, guessSide === 'c3' && styles.guessC3, guessSide === 'c4' && styles.guessC4)} key={marker.id}>
            {guessText(marker)}
          </p>
        ) : null}
        {turned ? (
          <span className={styles.reset}>
            <TextLink onClick={() => resetRef.current?.()}>Reset view</TextLink>
          </span>
        ) : null}
        <p className={styles.credit}>
          {MODEL_CREDIT_SHORT}{' '}
          <a href={LICENSE_URL} target="_blank" rel="noreferrer">
            CC BY 4.0
          </a>
        </p>
      </section>

      <section className={styles.strip} aria-label="Change from rest by frequency band, decoder guesses and jaw muscle">
        <BandStrip stream={stream} live={view.state === 'measuring'} />
      </section>

      <Dialog open={infoOpen} onClose={() => setInfoOpen(false)} title="About this view">
        <dl className={styles.details}>
          <dt>What glows</dt>
          <dd>{LABELS.explain}</dd>
          <dt>The brain</dt>
          <dd>{caption(wearer)}</dd>
          <dt>Rest baseline</dt>
          <dd>
            {view.details.baseline}{' '}
            {s.connected ? <TextLink onClick={() => stream.recordBaseline()}>Record again</TextLink> : null}
          </dd>
          <dt>Brain test</dt>
          <dd>{view.details.brainTest ?? 'No headset stream'}</dd>
          {view.details.laterality ? (
            <>
              <dt>Left vs right</dt>
              <dd className={styles.num}>{view.details.laterality}</dd>
            </>
          ) : null}
          <dt>Stream</dt>
          <dd className={styles.num}>
            {view.details.frameAge}
            {s.meta ? `. ${s.meta.board}, ${s.meta.srate} Hz, ${s.meta.units}, filter: ${s.meta.traceFilter}` : ''}
          </dd>
          {contact.length ? (
            <>
              <dt>Contact</dt>
              <dd>{contact.map(([name, c]) => `${name} ${c}`).join(', ')}</dd>
            </>
          ) : null}
          {marker && marker.source !== 'imagery' ? (
            <>
              <dt>Last command</dt>
              <dd>
                {marker.command} from a {sourceText(marker.source)}
              </dd>
            </>
          ) : null}
          {s.meta?.note ? (
            <>
              <dt>Bridge note</dt>
              <dd>{s.meta.note}</dd>
            </>
          ) : null}
          <dt>Credit</dt>
          <dd>
            Brain model:{' '}
            <a href={MODEL_DOI} target="_blank" rel="noreferrer">
              &quot;{MODEL_TITLE}&quot;
            </a>{' '}
            v1.3 by Kristen Browne and Heidi Schlehlein, Human Reference Atlas (HuBMAP), via NIH 3D (NIAID).{' '}
            <a href={LICENSE_URL} target="_blank" rel="noreferrer">
              CC BY 4.0
            </a>
            . Modified.
          </dd>
        </dl>
      </Dialog>
    </div>
  );
}
