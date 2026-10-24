'use client';

/**
 * What the form agent sees: the screenshot of the filled form, read-only and labeled
 * "Preview, not sent" (docs/ui.md pattern 6). A click opens it large in a dialog; Esc or a click
 * on the backdrop closes it. The image fades in when it loads (250 ms, none under reduced motion).
 *
 * The picture is shown exactly as the Actor took it. Text on the screen is masked for phone
 * numbers, but text inside an image cannot be, so a form that asks for a phone number would show it.
 */
import { useEffect, useRef, useState } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { Spinner } from '@/components/ui/Spinner';
import { StatusLine } from '@/components/ui/StatusLine';
import { cx } from '@/lib/cx';
import type { Errand } from '@/lib/data/types';
import { errandMaybeSent, screenText } from './model';
import styles from './FormPreview.module.css';

const MAKING_PREVIEW = ['Making the preview', 'Still filling in the form', 'Still filling in the form. Some pages take a few seconds.'] as const;

/** The label on the picture. It only says "Sent" once the row says the form was sent. */
function previewTag(errand: Errand): { text: string; sent: boolean } {
  if (errand.status === 'sent') return { text: 'Sent', sent: true };
  if (errandMaybeSent(errand)) return { text: 'Preview, outcome unknown', sent: false };
  return { text: 'Preview, not sent', sent: false };
}

export function FormPreview({ errand }: { errand: Errand }) {
  const url = errand.screenshotUrl?.trim() || null;
  if (url === null) return <PreviewPlaceholder errand={errand} />;
  // A new picture starts its own load and fade.
  return <PreviewImage key={url} url={url} errand={errand} />;
}

function PreviewPlaceholder({ errand }: { errand: Errand }) {
  if (errand.status === 'preparing') {
    return (
      <div className={styles.placeholder}>
        <StatusLine messages={MAKING_PREVIEW} resetKey={errand.id} />
      </div>
    );
  }
  const text = errand.previewedAt === null ? 'No preview. The form was not filled in.' : 'The preview is not shared with this screen.';
  return (
    <div className={styles.placeholder}>
      <p className={styles.placeholderText}>{text}</p>
    </div>
  );
}

function PreviewImage({ url, errand }: { url: string; errand: Errand }) {
  const [load, setLoad] = useState<'loading' | 'loaded' | 'error'>('loading');
  const [open, setOpen] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);
  const tag = previewTag(errand);
  const form = screenText(errand.form) ?? 'the form';

  useEffect(() => {
    // A cached picture can finish before the load handler runs.
    const img = imgRef.current;
    if (img && img.complete && img.naturalWidth > 0) setLoad('loaded');
  }, []);

  if (load === 'error') {
    return (
      <div className={styles.placeholder}>
        <p className={styles.placeholderText}>The preview picture did not load.</p>
      </div>
    );
  }

  return (
    <figure className={styles.preview}>
      <button
        type="button"
        className={styles.frame}
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-label={`Enlarge the screenshot of ${form}. ${tag.text}.`}
      >
        {/* A plain img: the Actor's screenshot can come from any host, so next/image would need each one listed. */}
        <img
          ref={imgRef}
          src={url}
          alt=""
          decoding="async"
          className={cx(styles.shot, load === 'loaded' && styles.loaded)}
          onLoad={() => setLoad('loaded')}
          onError={() => setLoad('error')}
        />
        {load === 'loading' ? (
          <span className={styles.loading}>
            <Spinner size={16} />
          </span>
        ) : null}
        <span className={cx(styles.tag, tag.sent && styles.tagSent)}>{tag.text}</span>
      </button>
      <figcaption className={styles.caption}>Click to enlarge</figcaption>
      <Dialog open={open} onClose={() => setOpen(false)} title={`${form}: ${tag.text}`} size="lg">
        <img src={url} alt={`Screenshot of the filled ${form} form. ${tag.text}.`} className={styles.full} />
      </Dialog>
    </figure>
  );
}
