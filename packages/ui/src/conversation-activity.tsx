import { useId, useState, type ReactNode } from 'react';

import { outcomeSections, type OutcomeSections } from '@cerebra/shared';

import {
  describeStep,
  exitCodeOf,
  fileChangeOf,
  stepCountOf,
  type FileChange,
  type HelperItem,
  type StepItem,
  type ThreadItem,
} from './conversation-thread';

const outputLimit = 20;

export const outcomeTitle = 'Confirm the outcome and where it goes next';

/** The five sections of an outcome, each under its heading. */
export function OutcomeSectionsView({
  sections,
}: {
  readonly sections: OutcomeSections;
}): ReactNode {
  return (
    <div className="mt-3 rounded-lg border border-[var(--border)] bg-[var(--background)] p-3">
      {outcomeSections.map((name) => (
        <div className="mt-3 first:mt-0" key={name}>
          <h3 className="text-sm font-bold">{name}</h3>
          <p className="mt-1 whitespace-pre-wrap break-words text-sm">
            {sections[name]}
          </p>
        </div>
      ))}
    </div>
  );
}

function AnsweredOutcome({
  at,
  name,
  sections,
  title,
}: {
  readonly at: string;
  readonly name: string;
  readonly sections: OutcomeSections;
  readonly title: string;
}): ReactNode {
  const id = useId();
  return (
    <section
      aria-labelledby={id}
      className="max-w-[85%] self-start rounded-2xl border border-[var(--border)] p-4"
    >
      <h2 className="font-bold" id={id}>
        {title}
      </h2>
      <OutcomeSectionsView sections={sections} />
      <p className="mt-2 text-xs text-[var(--muted)]">{`${name} · ${timeOf(at)}`}</p>
    </section>
  );
}

const lineButton =
  'flex w-full min-w-0 items-baseline gap-2 rounded border-l-2 border-[var(--border)] px-2 py-1 text-left font-mono text-sm text-[var(--muted)] outline-none hover:bg-[var(--accent-muted)] focus-visible:ring-3 focus-visible:ring-[var(--focus)]';

const detailBox =
  'mt-1 ml-4 min-w-0 rounded-lg border border-[var(--border)] p-2 font-mono text-xs';

export function timeOf(at: string): string {
  return new Date(at).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function Chevron({ open }: { readonly open: boolean }): ReactNode {
  return <span aria-hidden="true">{open ? '▾' : '▸'}</span>;
}

function Succeeded({ spoken }: { readonly spoken: boolean }): ReactNode {
  return (
    <span className="shrink-0 text-[var(--success)]">
      <span aria-hidden="true">✓</span>
      {spoken ? <span className="sr-only">Succeeded</span> : null}
    </span>
  );
}

function Output({ content }: { readonly content: string }): ReactNode {
  const [all, setAll] = useState(false);
  const text = content.replace(/\n$/, '');
  if (text === '') {
    return <p className="text-[var(--muted)]">No output.</p>;
  }
  const lines = text.split('\n');
  const cut = !all && lines.length > outputLimit;
  return (
    <div>
      <pre className="overflow-x-auto whitespace-pre" data-testid="step-output">
        {(cut ? lines.slice(0, outputLimit) : lines).join('\n')}
      </pre>
      {cut ? (
        <button
          className="mt-2 rounded font-sans font-bold text-[var(--accent)] underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-[var(--focus)]"
          onClick={() => setAll(true)}
          type="button"
        >
          {`Show all ${lines.length.toLocaleString()} lines`}
        </button>
      ) : null}
    </div>
  );
}

function DiffView({ change }: { readonly change: FileChange }): ReactNode {
  const added = change.lines.filter((line) => line.kind === 'added').length;
  const removed = change.lines.filter((line) => line.kind === 'removed').length;
  return (
    <div>
      <p className="break-words">
        {change.path}{' '}
        <span className="text-[var(--muted)]">{`+${added} −${removed}`}</span>
      </p>
      <div className="mt-1 overflow-x-auto">
        <div className="min-w-max">
          {change.lines.map((line, index) => (
            <div
              className={`whitespace-pre px-1 ${
                line.kind === 'added'
                  ? 'bg-[var(--diff-added)]'
                  : line.kind === 'removed'
                    ? 'bg-[var(--diff-removed)]'
                    : ''
              }`}
              data-diff={line.kind}
              key={index}
            >
              {line.kind === 'same' ? null : (
                <span className="sr-only">
                  {line.kind === 'added' ? 'Added: ' : 'Removed: '}
                </span>
              )}
              <span aria-hidden="true">
                {line.kind === 'added'
                  ? '+ '
                  : line.kind === 'removed'
                    ? '- '
                    : '  '}
              </span>
              <span>{line.text}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function StepLine({
  live,
  step,
}: {
  readonly live: boolean;
  readonly step: StepItem;
}): ReactNode {
  const change = fileChangeOf(step.name, step.input);
  const [override, setOverride] = useState<boolean | null>(null);
  const open = override ?? change !== null;
  const status =
    step.result === null
      ? live
        ? 'running'
        : 'failed'
      : step.result.isError
        ? 'failed'
        : 'ok';
  const code =
    step.result?.isError === true ? exitCodeOf(step.result.content) : null;
  return (
    <div className="min-w-0">
      <button
        aria-expanded={open}
        className={lineButton}
        onClick={() => setOverride(!open)}
        type="button"
      >
        <Chevron open={open} />
        <span className="min-w-0 break-words">
          {describeStep(step.name, step.input)}
        </span>
        {status === 'running' ? (
          <span className="shrink-0">Running…</span>
        ) : null}
        {status === 'ok' ? <Succeeded spoken /> : null}
        {status === 'failed' ? (
          <span className="shrink-0 text-[var(--danger)]">
            <span aria-hidden="true">✗ </span>
            <span>{code === null ? 'Failed' : `Failed — exit ${code}`}</span>
          </span>
        ) : null}
      </button>
      {open ? (
        <div className={detailBox}>
          {change !== null ? <DiffView change={change} /> : null}
          {change === null || status === 'failed' ? (
            <div className={change === null ? undefined : 'mt-2'}>
              {step.result === null && status === 'running' ? null : (
                <Output content={step.result?.content ?? ''} />
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function HelperNest({
  actions,
  helper,
  live,
  name,
}: {
  readonly actions: ThreadActions;
  readonly helper: HelperItem;
  readonly live: boolean;
  readonly name: string;
}): ReactNode {
  const status =
    helper.end === null
      ? live
        ? 'working'
        : 'failed'
      : helper.end.isError
        ? 'failed'
        : 'finished';
  const [override, setOverride] = useState<boolean | null>(null);
  const open = override ?? status === 'working';
  const count = stepCountOf(helper);
  const label =
    status === 'working'
      ? `Started helper: “${helper.task}”`
      : status === 'finished'
        ? `Helper “${helper.task}” finished · ${count} ${count === 1 ? 'step' : 'steps'}`
        : `Helper “${helper.task}” stopped unexpectedly`;
  return (
    <div className="min-w-0">
      <button
        aria-expanded={open}
        className={lineButton}
        onClick={() => setOverride(!open)}
        type="button"
      >
        <Chevron open={open} />
        <span
          className={`min-w-0 break-words ${
            status === 'failed' ? 'text-[var(--danger)]' : ''
          }`}
        >
          {label}
        </span>
        {status === 'working' ? (
          <span className="shrink-0 rounded-full bg-[var(--accent-muted)] px-2 font-sans text-xs font-bold text-[var(--accent)]">
            Working
          </span>
        ) : null}
        {status === 'finished' ? <Succeeded spoken={false} /> : null}
        {status === 'failed' ? (
          <span aria-hidden="true" className="shrink-0 text-[var(--danger)]">
            ✗
          </span>
        ) : null}
      </button>
      {open ? (
        <div
          aria-label={`Helper “${helper.task}”`}
          className="mt-2 ml-6 flex min-w-0 flex-col gap-3 border-l-2 border-dashed border-[var(--control-border)] pl-3"
          role="group"
        >
          <ThreadView
            actions={actions}
            helper
            items={helper.items}
            live={live}
            name={name}
            stillWorkingKey={null}
          />
        </div>
      ) : null}
    </div>
  );
}

export interface ThreadActions {
  /** Opens an item an agent filed; absent where there is nowhere to open it. */
  readonly onOpenItem?: (itemId: string) => void;
  /** Asks the agent to try a refused outcome again. */
  readonly onRetryOutcome?: () => void;
  /** The one refused outcome that offers Try again, if any. */
  readonly retryKey?: string | null;
}

/** Every item of a thread, as text: nothing an assistant sends is rendered as markup. */
export function ThreadView({
  actions = {},
  helper = false,
  items,
  live,
  name,
  stillWorkingKey,
}: {
  readonly actions?: ThreadActions;
  readonly helper?: boolean;
  readonly items: readonly ThreadItem[];
  readonly live: boolean;
  readonly name: string;
  readonly stillWorkingKey: string | null;
}): ReactNode {
  return items.map((item) => {
    if (item.kind === 'outcome') {
      return (
        <AnsweredOutcome
          at={item.at}
          key={item.key}
          name={name}
          sections={item.outcome.sections}
          title={item.outcome.title || outcomeTitle}
        />
      );
    }
    if (item.kind === 'filed') {
      const { onOpenItem } = actions;
      return (
        <p
          className="flex min-w-0 items-baseline gap-2 border-l-2 border-[var(--border)] px-2 py-1 text-sm text-[var(--muted)]"
          key={item.key}
        >
          <Succeeded spoken={false} />
          <span className="min-w-0 break-words">
            Filed “
            {onOpenItem === undefined ? (
              item.title
            ) : (
              <button
                className="rounded font-bold text-[var(--accent)] underline underline-offset-4 outline-none focus-visible:ring-3 focus-visible:ring-[var(--focus)]"
                onClick={() => onOpenItem(item.itemId)}
                type="button"
              >
                {item.title}
              </button>
            )}
            ”
          </span>
        </p>
      );
    }
    if (item.kind === 'outcome_failed') {
      return (
        <section
          className="max-w-[85%] self-start rounded-2xl border border-[var(--danger)] bg-red-50 p-4 dark:bg-red-950"
          key={item.key}
        >
          <h2 className="font-bold text-[var(--danger)]">
            {`${name} couldn’t record the outcome.`}
          </h2>
          <p className="mt-1">
            Nothing was moved. Your answer is kept; try again.
          </p>
          {item.key === actions.retryKey && actions.onRetryOutcome ? (
            <button
              className="primary-button mt-3"
              onClick={actions.onRetryOutcome}
              type="button"
            >
              Try again
            </button>
          ) : null}
        </section>
      );
    }
    if (item.kind === 'step') {
      return <StepLine key={item.key} live={live} step={item} />;
    }
    if (item.kind === 'helper') {
      return (
        <HelperNest
          actions={actions}
          helper={item}
          key={item.key}
          live={live}
          name={name}
        />
      );
    }
    return (
      <article
        className={`max-w-[85%] rounded-2xl p-3 ${
          item.kind === 'navigator'
            ? 'self-end bg-[var(--accent-muted)]'
            : 'self-start border border-[var(--border)]'
        }`}
        key={item.key}
      >
        <p className="whitespace-pre-wrap break-words">{item.text}</p>
        <p className="mt-1 text-xs text-[var(--muted)]">
          {item.kind === 'navigator' ? (
            'You'
          ) : helper ? (
            <span>Helper</span>
          ) : (
            name
          )}
          {` · ${timeOf(item.at)}`}
          {item.key === stillWorkingKey ? (
            <span className="ml-2 font-bold text-[var(--accent)]">
              Still working…
            </span>
          ) : null}
        </p>
      </article>
    );
  });
}
