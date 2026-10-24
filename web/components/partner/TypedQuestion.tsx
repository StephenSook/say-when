'use client';

/**
 * The typed question, the fallback below "Hold to ask" (docs/ui.md "Screen 4"): a 56 px pill with
 * 16 px text, so iOS does not zoom in, and "Send" inside it. A failed send shows "Could not send. Try
 * again." above the pill as an alert, with the raw error as its tooltip. The screen renders this only
 * when there is a sender (components/partner/useAsk.ts).
 */
import { useRef, useState } from 'react';
import { CrossIcon } from '@/components/ui/icons';
import { PillInput } from '@/components/ui/PillInput';
import { MAX_QUESTION_LENGTH, newRequestId, type AskFn } from './useAsk';
import styles from './TypedQuestion.module.css';

interface SendError {
  sentence: string;
  raw: string | null;
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

  const submit = async (text: string) => {
    if (sending) return;
    if (text.length > MAX_QUESTION_LENGTH) {
      setError({ sentence: `Too long. Keep it under ${MAX_QUESTION_LENGTH} characters.`, raw: null });
      return;
    }
    if (!attempt.current || attempt.current.text !== text) attempt.current = { text, requestId: newRequestId() };
    const { requestId } = attempt.current;
    setSending(true);
    setError(null);
    try {
      await send({ requestId, text, via: 'typed', listenMs: 0 });
      attempt.current = null;
      setValue('');
    } catch (failure) {
      setError({ sentence: 'Could not send. Try again.', raw: errorText(failure) });
    } finally {
      setSending(false);
    }
  };

  return (
    <div className={styles.typed}>
      {error ? (
        <p className={styles.error} role="alert" title={error.raw ?? undefined}>
          <CrossIcon size={14} />
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
