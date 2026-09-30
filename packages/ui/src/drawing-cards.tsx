import {
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';

import { mockupEscapeMessage, type Drawing } from '@cerebra/shared';

import { timeOf } from './conversation-activity';
import type { DrawingsItem } from './conversation-thread';
import { trapFocus } from './focus-trap';
import { MockupLocatorContext } from './mockups';
import type { DrawingsReply } from './runs';

/** The short name a drawing is chosen by: "A" of "A · Button in the toolbar". */
export function letterOf(drawing: Drawing, index: number): string {
  const match = /^(\S{1,3}) · /.exec(drawing.label);
  return match?.[1] ?? String.fromCharCode(65 + (index % 26));
}

/** How long a drawing may take to appear before it counts as not shown. */
export const drawingLoadLimitMs = 20_000;

type Showing =
  | { readonly state: 'loading'; readonly url: string | null }
  | { readonly state: 'shown'; readonly url: string }
  | { readonly state: 'failed' };

/**
 * A drawing as the designer made it, served from an origin of its own (architecture §11): in a
 * card, a still picture a quarter of its size that opens full size when clicked; full size, live.
 * While it loads a shimmer stands in for it; if it cannot be shown, it says so and offers to try
 * again.
 */
export function DrawingPreview({
  drawing,
  failure = 'This drawing couldn’t be shown.',
  large = false,
  onOpen,
}: {
  readonly drawing: Drawing;
  /** What its place says when it cannot be shown. */
  readonly failure?: string;
  readonly large?: boolean;
  readonly onOpen?: () => void;
}): ReactNode {
  const locate = useContext(MockupLocatorContext);
  const [attempt, setAttempt] = useState(0);
  const [showing, setShowing] = useState<Showing>({
    state: 'loading',
    url: null,
  });
  const { mockupId } = drawing;

  useEffect(() => {
    if (mockupId === null) {
      setShowing({ state: 'failed' });
      return;
    }
    let current = true;
    setShowing({ state: 'loading', url: null });
    const limit = setTimeout(() => {
      if (current) {
        setShowing((was) =>
          was.state === 'loading' ? { state: 'failed' } : was,
        );
      }
    }, drawingLoadLimitMs);
    locate(mockupId).then(
      (url) => {
        if (current) {
          setShowing((was) =>
            was.state === 'loading' ? { state: 'loading', url } : was,
          );
        }
      },
      () => {
        if (current) setShowing({ state: 'failed' });
      },
    );
    return () => {
      current = false;
      clearTimeout(limit);
    };
  }, [attempt, locate, mockupId]);

  const box = `relative w-full overflow-hidden rounded-lg border border-[var(--border)] bg-white dark:bg-[var(--background)] ${
    large ? 'min-h-0 flex-1' : 'h-32'
  }`;

  if (showing.state === 'failed') {
    return (
      <div
        className={`${box} flex flex-col items-center justify-center gap-2 p-2 text-center text-sm text-[var(--muted)]`}
      >
        {failure}
        <button
          className="secondary-button text-sm"
          onClick={() => setAttempt((count) => count + 1)}
          type="button"
        >
          Try again
        </button>
      </div>
    );
  }

  const loading = showing.state === 'loading';
  const url = showing.url;
  return (
    <div aria-busy={loading ? true : undefined} className={box}>
      {url === null ? null : large ? (
        // Live, in a sandbox without the application's origin; it forwards Escape by message.
        <iframe
          className={`h-full w-full border-0 ${loading ? 'invisible' : ''}`}
          key={attempt}
          onLoad={() => setShowing({ state: 'shown', url })}
          sandbox="allow-scripts"
          src={url}
          tabIndex={0}
          title={drawing.label}
        />
      ) : (
        // A still picture: no scripts, no focus, no pointer; drawn at four times the card's size.
        <iframe
          aria-hidden="true"
          className={`pointer-events-none absolute left-0 top-0 h-[400%] w-[400%] origin-top-left scale-25 border-0 ${
            loading ? 'invisible' : ''
          }`}
          inert
          key={attempt}
          onLoad={() => setShowing({ state: 'shown', url })}
          sandbox=""
          src={url}
          tabIndex={-1}
          title={drawing.label}
        />
      )}
      {loading ? (
        <div className="absolute inset-0 animate-pulse bg-[var(--border)] motion-reduce:animate-none" />
      ) : null}
      {onOpen === undefined ? null : (
        // A pointer shortcut to "Open full size", which keyboards already reach.
        <div
          aria-hidden="true"
          className="absolute inset-0 cursor-zoom-in"
          onClick={onOpen}
        />
      )}
    </div>
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
  /** Who drew it, when it is shown for choosing between. */
  readonly name?: string;
  readonly onChoose?: (label: string) => void;
  readonly onClose: () => void;
  readonly onIndex: (index: number) => void;
}): ReactNode {
  const id = useId();
  const close = useRef<HTMLButtonElement>(null);
  const first = useRef<HTMLButtonElement>(null);
  const area = useRef<HTMLDivElement>(null);
  const drawing = drawings[index]!;
  const count = drawings.length;

  useEffect(() => {
    close.current?.focus();
  }, []);

  // Keys pressed inside the live drawing stay in its frame; it posts Escape here instead.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frame = area.current?.querySelector('iframe');
      if (
        frame !== null &&
        frame !== undefined &&
        event.source === frame.contentWindow &&
        event.data === mockupEscapeMessage
      ) {
        onClose();
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [onClose]);

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
            ref={first}
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
        {name === undefined ? null : (
          <p className="sr-only">{`${name} drew this for you to choose from.`}</p>
        )}
        <div className="mt-3 flex min-h-0 flex-1 flex-col" ref={area}>
          <DrawingPreview drawing={drawing} key={index} large />
        </div>
        {/* Tab out of the live drawing comes back to the dialog's first control. */}
        <div
          data-focus-return=""
          onFocus={() => first.current?.focus()}
          tabIndex={0}
        />
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
            <DrawingPreview
              drawing={drawing}
              onOpen={() => setShown({ at: index, from: index })}
            />
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
 * The one drawing a record keeps (spec §4.11): its picture, and a way to open it full size in the
 * same sandboxed view the chat uses; closing it returns focus to "Open full size".
 */
export function ChosenDrawing({
  drawing,
  failure,
}: {
  readonly drawing: Drawing;
  readonly failure?: string;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);

  return (
    <div className="mt-2 flex max-w-md flex-col">
      <DrawingPreview
        drawing={drawing}
        failure={failure}
        onOpen={() => setOpen(true)}
      />
      <button
        className="secondary-button mt-2 self-start text-sm"
        onClick={() => setOpen(true)}
        ref={opener}
        type="button"
      >
        Open full size
      </button>
      {open ? (
        <DrawingDialog
          drawings={[drawing]}
          index={0}
          onClose={() => {
            setOpen(false);
            opener.current?.focus();
          }}
          onIndex={() => {}}
        />
      ) : null}
    </div>
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

  if (round.status === 'preparing') {
    // A set that never arrived is not history: after the run it is simply gone.
    if (!live) return null;
    return (
      <section
        aria-busy="true"
        aria-labelledby={`${id}-title`}
        className="w-full max-w-[85%] self-start rounded-2xl border border-[var(--border)] p-4 max-sm:max-w-full"
      >
        <h2 className="font-bold" id={`${id}-title`}>
          {round.question}
        </h2>
        <ul className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-[repeat(auto-fit,minmax(12rem,1fr))]">
          {Array.from({ length: round.count }, (_, index) => (
            <li
              className="flex h-32 animate-pulse items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--surface)] p-2 text-sm text-[var(--muted)] motion-reduce:animate-none"
              key={index}
            >
              {index === 0 ? 'Preparing drawings…' : null}
            </li>
          ))}
        </ul>
      </section>
    );
  }

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
