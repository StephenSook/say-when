'use client';

/**
 * The 24 px round play button for a voice clip (docs/ui.md "Screen 1": only when the speak row
 * carries a clip address). Pressing it again stops the clip.
 */
import { useEffect, useRef, useState } from 'react';
import { PauseIcon } from '@/components/ui/icons';
import styles from './ClipButton.module.css';

function PlayIcon() {
  return (
    <svg width={10} height={10} viewBox="0 0 10 10" aria-hidden="true" focusable="false">
      <path d="M2.5 1.5v7l6-3.5z" fill="currentColor" />
    </svg>
  );
}

export function ClipButton({ url, label }: { url: string; label: string }) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);

  // A new clip, or leaving the screen, stops the old one.
  useEffect(() => {
    return () => {
      audio.current?.pause();
      audio.current = null;
      setPlaying(false);
    };
  }, [url]);

  const toggle = () => {
    const current = audio.current;
    if (current && playing) {
      current.pause();
      setPlaying(false);
      return;
    }
    const element = current ?? new Audio(url);
    audio.current = element;
    element.onended = () => setPlaying(false);
    element.onerror = () => setPlaying(false);
    element.currentTime = 0;
    element.play().then(
      () => setPlaying(true),
      () => setPlaying(false),
    );
  };

  const name = playing ? `Stop: ${label}` : label;
  return (
    <button type="button" className={styles.play} onClick={toggle} aria-label={name} title={name}>
      {playing ? <PauseIcon size={10} /> : <PlayIcon />}
    </button>
  );
}
