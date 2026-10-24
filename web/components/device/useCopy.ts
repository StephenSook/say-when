'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export type CopyResult = 'idle' | 'copied' | 'failed';

/**
 * Copies text with the Clipboard API and reports the result for 2 s. Used for the owner's commands and the device
 * id, which are not secrets. Never pass a token here.
 */
export function useCopy(): { result: CopyResult; which: string | null; copy: (which: string, text: string) => void } {
  const [result, setResult] = useState<CopyResult>('idle');
  const [which, setWhich] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const copy = useCallback((name: string, text: string) => {
    const done = (value: CopyResult) => {
      setWhich(name);
      setResult(value);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setResult('idle'), 2_000);
    };
    try {
      const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
      if (!clipboard) {
        done('failed');
        return;
      }
      clipboard.writeText(text).then(
        () => done('copied'),
        () => done('failed'),
      );
    } catch {
      done('failed');
    }
  }, []);

  return { result, which, copy };
}
