'use client';

import { useId, type FormEvent, type ReactNode } from 'react';
import { cx } from '@/lib/cx';
import styles from './PillInput.module.css';

export interface PillInputProps {
  value: string;
  onChange: (value: string) => void;
  /** Called with the trimmed text when the person presses Send or Enter. Never called with empty text. */
  onSubmit: (text: string) => void;
  /** The input's name for screen readers, for example "Type a question". */
  label: string;
  placeholder?: string;
  /** The text button inside the pill. Default "Send". */
  submitLabel?: string;
  /** An icon on the left. */
  icon?: ReactNode;
  disabled?: boolean;
  /** md is 44 px tall; phone is 56 px, a thumb target (docs/ui.md tokens). */
  size?: 'md' | 'phone';
  className?: string;
}

/**
 * A rounded input with a text button inside (docs/ui.md "Pill input"). The text is always 16 px, so
 * iOS does not zoom in when it gets focus.
 */
export function PillInput({
  value,
  onChange,
  onSubmit,
  label,
  placeholder,
  submitLabel = 'Send',
  icon,
  disabled = false,
  size = 'md',
  className,
}: PillInputProps) {
  const inputId = useId();
  const empty = value.trim() === '';

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = value.trim();
    if (disabled || text === '') return;
    onSubmit(text);
  };

  return (
    <form className={cx(styles.pill, size === 'phone' && styles.phone, disabled && styles.disabled, className)} onSubmit={handleSubmit}>
      {icon ? (
        <span className={styles.icon} aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <label htmlFor={inputId} className="visually-hidden">
        {label}
      </label>
      <input
        id={inputId}
        className={styles.input}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete="off"
        enterKeyHint="send"
      />
      <button type="submit" className={styles.submit} disabled={disabled || empty}>
        {submitLabel}
      </button>
    </form>
  );
}
