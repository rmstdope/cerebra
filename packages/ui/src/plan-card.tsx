import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

import type { PlanItem } from './conversation-thread';
import type { PlanVerdict } from './runs';

const emptyChanges =
  'Say what should change so the builder can revise the plan.';
const notSent = 'Your answer wasn’t sent. Try again.';

function eyebrowOf(plan: PlanItem, stale: boolean): string {
  if (plan.status === 'approved') return 'Plan · approved';
  if (plan.status === 'changes') return 'Plan · you asked for changes';
  if (stale) return 'Plan · no longer waiting';
  return plan.revised
    ? 'Plan · revised · for your approval'
    : 'Plan for your approval';
}

/**
 * A builder's plan in its conversation (spec §4.9): answerable while the builder waits for it,
 * read-only once answered or once nobody is waiting.
 */
export function PlanCard({
  live,
  onAnswer,
  plan,
  title,
}: {
  readonly live: boolean;
  readonly onAnswer?: (
    planId: number,
    verdict: PlanVerdict,
    text: string,
  ) => Promise<void>;
  readonly plan: PlanItem;
  readonly title: string;
}): ReactNode {
  const id = useId();
  const card = useRef<HTMLElement>(null);
  const askButton = useRef<HTMLButtonElement>(null);
  const changesBox = useRef<HTMLTextAreaElement>(null);
  const [asking, setAsking] = useState(false);
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const stale =
    plan.status === 'superseded' || (plan.status === 'open' && !live);
  const waiting =
    plan.status === 'open' && live && onAnswer !== undefined && !sent;

  useEffect(() => {
    if (waiting) card.current?.focus();
    // Only when the card first waits, as an open question's form does.
  }, [plan.planId]);

  const returnToAsk = useRef(false);
  useEffect(() => {
    if (asking) changesBox.current?.focus();
    else if (returnToAsk.current) askButton.current?.focus();
    returnToAsk.current = false;
  }, [asking]);

  useEffect(() => {
    if (sent) card.current?.focus();
  }, [sent]);

  const send = async (verdict: PlanVerdict, said: string) => {
    if (onAnswer === undefined || sending) return;
    setProblem(null);
    setSending(true);
    try {
      await onAnswer(plan.planId, verdict, said);
      setSent(true);
      setAsking(false);
    } catch {
      setProblem(notSent);
    } finally {
      setSending(false);
    }
  };

  const eyebrow = eyebrowOf(plan, stale);

  return (
    <section
      aria-labelledby={`${id}-eyebrow ${id}-title`}
      className={`w-full max-w-[85%] self-start rounded-2xl border bg-[var(--surface)] p-4 shadow-sm outline-none focus-visible:ring-3 focus-visible:ring-[var(--focus)] max-sm:max-w-full ${
        waiting ? 'border-[var(--accent)]' : 'border-[var(--border)]'
      }`}
      ref={card}
      tabIndex={-1}
    >
      <p
        className="text-xs font-bold tracking-wide text-[var(--accent)] uppercase"
        id={`${id}-eyebrow`}
      >
        {eyebrow}
      </p>
      <h2 className="mt-1 font-bold break-words" id={`${id}-title`}>
        {title}
      </h2>
      {plan.status === 'changes' && plan.request !== null ? (
        <blockquote className="mt-2 text-sm break-words whitespace-pre-wrap">
          {`“${plan.request}”`}
        </blockquote>
      ) : null}
      {plan.status === 'open' && stale ? (
        <p className="mt-2 text-sm text-[var(--muted)]">
          The builder stopped before you answered. The next builder writes a new
          plan.
        </p>
      ) : null}
      {waiting ? (
        <>
          <div className="mt-3 rounded-lg border border-[var(--border)] bg-[var(--background)] p-3">
            {plan.sections.map((section) => (
              <div className="mt-3 first:mt-0" key={section.title}>
                <h3 className="text-sm font-bold">{section.title}</h3>
                <p className="mt-1 text-sm break-words whitespace-pre-wrap">
                  {section.text}
                </p>
              </div>
            ))}
          </div>
          {problem !== null ? (
            <p className="auth-error mt-3" role="alert">
              {problem}
            </p>
          ) : null}
          {asking ? (
            <form
              className="mt-3"
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                const said = text.trim();
                if (said === '') {
                  setProblem(emptyChanges);
                  changesBox.current?.focus();
                  return;
                }
                void send('changes', said);
              }}
            >
              <label className="auth-label mt-0" htmlFor={`${id}-changes`}>
                What should change?
              </label>
              <textarea
                className="auth-input min-h-20 resize-y"
                id={`${id}-changes`}
                onChange={(event) => setText(event.target.value)}
                ref={changesBox}
                value={text}
              />
              <div className="mt-3 flex flex-wrap gap-2 max-sm:flex-col">
                <button
                  className="primary-button"
                  disabled={sending}
                  type="submit"
                >
                  Send
                </button>
                <button
                  className="secondary-button"
                  onClick={() => {
                    returnToAsk.current = true;
                    setAsking(false);
                    setProblem(null);
                  }}
                  type="button"
                >
                  Cancel
                </button>
              </div>
            </form>
          ) : null}
          <div
            className={`mt-3 flex flex-wrap gap-2 max-sm:flex-col ${asking ? 'hidden' : ''}`}
          >
            <button
              className="primary-button"
              disabled={sending}
              onClick={() => void send('approved', '')}
              type="button"
            >
              Approve plan
            </button>
            <button
              className="secondary-button"
              disabled={sending}
              onClick={() => {
                setProblem(null);
                setAsking(true);
              }}
              ref={askButton}
              type="button"
            >
              Ask for changes…
            </button>
          </div>
        </>
      ) : null}
    </section>
  );
}
