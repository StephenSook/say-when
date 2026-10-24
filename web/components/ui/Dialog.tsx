'use client';

import { useEffect, useId, useRef, type ReactNode } from 'react';
import { cx } from '@/lib/cx';
import styles from './Dialog.module.css';

export interface DialogProps {
  open: boolean;
  /** Called when the dialog closes: Esc, a click on the backdrop, or the Close button. Set `open` to false here. */
  onClose: () => void;
  /** Shown at the top and used as the dialog's name for screen readers. */
  title: string;
  children: ReactNode;
  /** md is 560 px wide; lg is 960 px, for a screenshot. */
  size?: 'md' | 'lg';
  className?: string;
}

/**
 * A native modal <dialog> (docs/ui.md "Dialog"): dialog radius and shadow over the backdrop color.
 * Esc or a click on the backdrop closes it, and keys 1, 2 and 3 do not switch screens while it is open.
 */
export function Dialog({ open, onClose, title, children, size = 'md', className }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const handleClose = () => onClose();
    dialog.addEventListener('close', handleClose);
    return () => dialog.removeEventListener('close', handleClose);
  }, [onClose]);

  return (
    <dialog
      ref={ref}
      className={cx(styles.dialog, size === 'lg' && styles.lg, className)}
      aria-labelledby={titleId}
      onClick={(event) => {
        // A click on the backdrop lands on the <dialog> itself; clicks on the content land on its children.
        if (event.target === event.currentTarget) event.currentTarget.close();
      }}
    >
      <div className={styles.inner}>
        <div className={styles.head}>
          <h2 id={titleId} className={styles.title}>
            {title}
          </h2>
          <button type="button" className={styles.close} onClick={() => ref.current?.close()}>
            Close
          </button>
        </div>
        {children}
      </div>
    </dialog>
  );
}
