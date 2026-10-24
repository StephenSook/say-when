'use client';

/**
 * The typed question, the fallback below "Hold to ask" (docs/ui.md "Screen 4", docs/station.md 4.3): a 56 px pill
 * with 16 px text, so iOS does not zoom in, and "Send" inside it. The screen renders this only when there is a sender
 * (components/partner/useAsk.ts), which is once the phone is paired.
 *
 * - The words are trimmed, cleaned of control characters and checked for 1 to 500 characters before sending.
 * - The same words sent again reuse their request id, so Send after a dropped connection is not a second question.
 * - A failed send shows its sentence above the pill (lib/partner/ask.ts): "The station is not running. Nothing was
 *   sent." in muted text with a pause mark, or "Could not send. Try again." as an error, with the raw error as its
 *   tooltip only.
 */
import { useRef, useState } from 'react';
import { CrossIcon, PauseIcon } from '@/components/ui/icons';
import { PillInput } from '@/components/ui/PillInput';
import { cx } from '@/lib/cx';
import { ASK_TEXT, AskError, prepareQuestion, requestIdFor } from '@/lib/partner/ask';
import { newRequestId, type AskFn } from './useAsk';
import styles from './TypedQuestion.module.css';

interface SendError {
  sentence: string;
  raw: string | null;
  /** Nothing broke (no session): muted, not red. */
  quiet: boolean;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}

export function TypedQuestion({ send }: { send: AskFn }) {
  const [value, setValue] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<SendError | null>(null);
  // The same words sent again reuse the request id, so a retry after a dropped connection is not a second question.
  const attempt = useRef<{ text: string; requestId: string } | null>(null);

  const submit = async (raw: string) => {
    if (sending) return;
    const prepared = prepareQuestion(raw);
    if (!prepared.ok) {
      setError({ sentence: prepared.sentence, raw: null, quiet: false });
      return;
    }
    attempt.current = requestIdFor(attempt.current, prepared.text, newRequestId);
    const { requestId, text } = attempt.current;
    setSending(true);
    setError(null);
    try {
      await send({ requestId, text, via: 'typed', listenMs: 0 });
      attempt.current = null;
      setValue('');
    } catch (failure) {
      if (failure instanceof AskError) setError({ sentence: failure.sentence, raw: failure.title, quiet: failure.kind === 'no_session' });
      else setError({ sentence: ASK_TEXT.couldNotSend, raw: errorText(failure), quiet: false });
    } finally {
      setSending(false);
    }
  };

  return (
    <div className={styles.typed}>
      {error ? (
        <p className={cx(styles.error, error.quiet && styles.quiet)} role="alert" title={error.raw ?? undefined}>
          {error.quiet ? <PauseIcon size={14} /> : <CrossIcon size={14} />}
          <span>{error.sentence}</span>
        </p>
      ) : null}
      <PillInput
        size="phone"
        value={value}
        onChange={setValue}
        onSubmit={(text) => void submit(text)}
        label="Type a question"
        placeholder="Type a question"
        submitLabel={sending ? 'Sending' : 'Send'}
        disabled={sending}
      />
    </div>
  );
}
