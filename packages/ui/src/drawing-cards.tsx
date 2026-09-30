import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';

import type { Drawing } from '@cerebra/shared';

import { timeOf } from './conversation-activity';
import type { DrawingsItem } from './conversation-thread';
import { trapFocus } from './focus-trap';
import type { DrawingsReply } from './runs';

/** The short name a drawing is chosen by: "A" of "A · Button in the toolbar". */
export function letterOf(drawing: Drawing, index: number): string {
  const match = /^(\S{1,3}) · /.exec(drawing.label);
  return match?.[1] ?? String.fromCharCode(65 + (index % 26));
}

/** A drawing as the designer made it, in a frame of its own; or why it cannot be shown. */
export function DrawingPreview({
  drawing,
  large = false,
}: {
  readonly drawing: Drawing;
  readonly large?: boolean;
}): ReactNode {
  const box = `w-full rounded-lg border border-[var(--border)] bg-white ${
    large ? 'min-h-0 flex-1' : 'h-32'
  }`;
  if (drawing.url === null) {
    return (
      <div
        className={`${box} grid place-items-center p-2 text-center text-sm text-[var(--muted)] dark:bg-[var(--background)]`}
      >
        This drawing couldn’t be shown.
      </div>
    );
  }
  return (
    // The drawing runs its own scripts in a sandbox, away from the application's origin.
    <iframe
      className={`${box} ${large ? '' : 'pointer-events-none'}`}
      sandbox="allow-scripts"
      src={drawing.url}
      tabIndex={-1}
      title={drawing.label}
    />
  );
}

/** One drawing at full size over the chat, with the rest of its round a step away. */
function DrawingDialog({
  drawings,
  index,
  name,
  onChoose,
  onClose,
  onIndex,
}: {
  readonly drawings: readonly Drawing[];
  readonly index: number;
  readonly name: string;
  readonly onChoose?: (label: string) => void;
  readonly onClose: () => void;
  readonly onIndex: (index: number) => void;
}): ReactNode {
  const id = useId();
  const close = useRef<HTMLButtonElement>(null);
  const drawing = drawings[index]!;
  const count = drawings.length;

  useEffect(() => {
    close.current?.focus();
  }, []);

  return (
    <div
      aria-labelledby={`${id}-title`}
      aria-modal="true"
      className="fixed inset-0 z-30 grid place-items-center bg-black/40 sm:p-5"
      onKeyDown={(event) => trapFocus(event, onClose)}
      role="dialog"
    >
      <section className="flex h-full w-full flex-col bg-[var(--surface)] p-4 shadow-lg sm:h-[90vh] sm:max-w-[1100px] sm:rounded-2xl">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-bold" id={`${id}-title`}>
            {drawing.label}
          </h2>
          <span className="text-sm text-[var(--muted)]">{`${index + 1} of ${count}`}</span>
          <span className="flex-1" />
          <button
            className="secondary-button text-sm"
            onClick={() => onIndex((index - 1 + count) % count)}
            type="button"
          >
            ‹ Previous
          </button>
          <button
            className="secondary-button text-sm"
            onClick={() => onIndex((index + 1) % count)}
            type="button"
          >
            Next ›
          </button>
          {onChoose === undefined ? null : (
            <button
              className="primary-button text-sm"
              onClick={() => onChoose(drawing.label)}
              type="button"
            >
              {`Choose ${letterOf(drawing, index)}`}
            </button>
          )}
          <button
            aria-label="Close"
            className="secondary-button text-sm"
            onClick={onClose}
            ref={close}
            type="button"
          >
            ✕
          </button>
        </div>
        <p className="sr-only">{`${name} drew this for you to choose from.`}</p>
        <div className="mt-3 flex min-h-0 flex-1 flex-col">
          <DrawingPreview drawing={drawing} large />
        </div>
      </section>
    </div>
  );
}

/**
 * A round's drawings side by side, wrapping onto new rows; one column on a narrow window. Each
 * opens full size; with `onChoose` each can be chosen.
 */
export function DrawingCards({
  disabled = false,
  drawings,
  name,
  onChoose,
}: {
  readonly disabled?: boolean;
  readonly drawings: readonly Drawing[];
  readonly name: string;
  readonly onChoose?: (label: string) => void;
}): ReactNode {
  const [shown, setShown] = useState<{ from: number; at: number } | null>(null);
  const openers = useRef<(HTMLButtonElement | null)[]>([]);

  const close = () => {
    const from = shown?.from;
    setShown(null);
    if (from !== undefined) openers.current[from]?.focus();
  };

  return (
    <>
      <ul className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-[repeat(auto-fit,minmax(12rem,1fr))]">
        {drawings.map((drawing, index) => (
          <li
            className="flex min-w-0 flex-col rounded-xl border border-[var(--border)] bg-[var(--surface)] p-2"
            key={drawing.label}
          >
            <DrawingPreview drawing={drawing} />
            <b className="mt-2 break-words px-0.5">{drawing.label}</b>
            <span className="mb-2 break-words px-0.5 text-sm text-[var(--muted)]">
              {drawing.recommended
                ? `${drawing.cost} (recommended by ${name})`.trim()
                : drawing.cost}
            </span>
            <div className="mt-auto flex flex-wrap gap-2">
              <button
                className="secondary-button text-sm"
                onClick={() => setShown({ at: index, from: index })}
                ref={(element) => {
                  openers.current[index] = element;
                }}
                type="button"
              >
                Open full size
              </button>
              {onChoose === undefined ? null : (
                <button
                  className="primary-button text-sm"
                  disabled={disabled}
                  onClick={() => onChoose(drawing.label)}
                  type="button"
                >
                  {`Choose ${letterOf(drawing, index)}`}
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {shown === null ? null : (
        <DrawingDialog
          drawings={drawings}
          index={shown.at}
          name={name}
          onChoose={
            onChoose === undefined || disabled
              ? undefined
              : (label) => {
                  setShown(null);
                  onChoose(label);
                }
          }
          onClose={close}
          onIndex={(at) => setShown({ at, from: shown.from })}
        />
      )}
    </>
  );
}

/**
 * A designer's round of drawings in the thread (spec §6.3): while it waits, the one question the
 * designer needs answered; afterwards, the drawings it showed, to look at again.
 */
export function DrawingsRoundView({
  live,
  name,
  onAnswer,
  round,
}: {
  readonly live: boolean;
  readonly name: string;
  readonly onAnswer?: (reply: DrawingsReply) => Promise<void>;
  readonly round: DrawingsItem;
}): ReactNode {
  const id = useId();
  const form = useRef<HTMLFormElement>(null);
  const [own, setOwn] = useState('');
  const [sending, setSending] = useState(false);
  const open = live && round.status === 'open' && onAnswer !== undefined;

  useEffect(() => {
    if (open) form.current?.focus();
  }, [open]);

  if (!open) {
    return (
      <section
        aria-labelledby={`${id}-title`}
        className="w-full max-w-[85%] self-start rounded-2xl border border-[var(--border)] p-4 max-sm:max-w-full"
      >
        <h2 className="font-bold" id={`${id}-title`}>
          {round.question}
        </h2>
        <DrawingCards drawings={round.drawings} name={name} />
        <p className="mt-2 text-xs text-[var(--muted)]">{`${name} · ${timeOf(round.at)}`}</p>
      </section>
    );
  }

  const reply = async (answer: DrawingsReply) => {
    if (sending) return;
    setSending(true);
    try {
      await onAnswer(answer);
    } finally {
      setSending(false);
    }
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const text = own.trim();
    if (text === '') return;
    void reply({ text });
  };

  return (
    <form
      aria-labelledby={`${id}-title`}
      className="w-full rounded-2xl border border-[var(--accent)] bg-[var(--surface)] p-4 shadow-sm outline-none focus-visible:ring-3 focus-visible:ring-[var(--focus)]"
      onSubmit={onSubmit}
      ref={form}
      tabIndex={-1}
    >
      <h2 className="font-bold" id={`${id}-title`}>
        {round.question}
      </h2>
      <p className="mt-1 text-sm text-[var(--muted)]">
        {`${name} needs one answer before it can continue.`}
      </p>
      <DrawingCards
        disabled={sending}
        drawings={round.drawings}
        name={name}
        onChoose={(choice) => void reply({ choice })}
      />
      <label className="auth-label" htmlFor={`${id}-own`}>
        Or say what to change
      </label>
      <div className="flex gap-2">
        <input
          className="auth-input min-w-0 flex-1"
          id={`${id}-own`}
          onChange={(event) => setOwn(event.target.value)}
          value={own}
        />
        <button
          className="primary-button self-end"
          disabled={own.trim() === '' || sending}
          type="submit"
        >
          Send
        </button>
      </div>
    </form>
  );
}
