import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

import {
  confirmDesignLabel,
  confirmDesignTitle,
  parseDesignQuestion,
  parseOutcomeQuestion,
  routeChoices,
  type DesignQuestion,
  type Drawing,
  type OutcomeQuestion,
  type OutcomeRoute,
} from '@cerebra/shared';

import type { AgentRole } from './fleet';
import { roleNames } from './fleet-page';
import {
  DesignSectionsView,
  OutcomeSectionsView,
  ThreadView,
  outcomeTitle,
  timeOf,
} from './conversation-activity';
import {
  buildThread,
  describeStep,
  drawingNamed,
  outcomeMoveOf,
  type ThreadItem,
} from './conversation-thread';
import { trapFocus } from './focus-trap';
import {
  browserConversationClient,
  ConversationRequestError,
  type Conversation,
  type ConversationClient,
  type DrawingsReply,
  type PlanVerdict,
  type Question,
  type RecordedEvent,
  type RunState,
  type RunUpdate,
} from './runs';

type Shown = 'ready' | 'working' | 'waiting' | 'finished' | 'failed';

interface OpenQuestion {
  readonly questionId: string;
  readonly questions: readonly Question[];
}

const link =
  'rounded font-bold text-[var(--accent)] underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-[var(--focus)]';

function isTopLevel(record: RecordedEvent): boolean {
  return record.event.parentToolCallId === undefined;
}

function openQuestionOf(events: readonly RecordedEvent[]): OpenQuestion | null {
  const answered = new Set(
    events.flatMap(({ event }) =>
      event.kind === 'answer' ? [event.questionId] : [],
    ),
  );
  for (const { event } of [...events].reverse()) {
    if (event.kind === 'question' && !answered.has(event.questionId)) {
      return { questionId: event.questionId, questions: event.questions };
    }
  }
  return null;
}

function hasOpenPlan(events: readonly RecordedEvent[]): boolean {
  let open = false;
  for (const { event } of events) {
    if (event.kind === 'plan_approval') open = true;
    if (event.kind === 'plan_answer' || event.kind === 'plan_withdrawn') {
      open = false;
    }
  }
  return open;
}

/** Whether the designer's newest round of drawings still waits for the navigator. */
function hasOpenDrawings(events: readonly RecordedEvent[]): boolean {
  let open = false;
  for (const { event } of events) {
    if (event.kind === 'drawings') open = true;
    if (
      event.kind === 'drawings_answer' ||
      event.kind === 'drawings_withdrawn'
    ) {
      open = false;
    }
  }
  return open;
}

function activityOf(events: readonly RecordedEvent[]): string[] {
  return events
    .filter(isTopLevel)
    .flatMap(({ event }) =>
      event.kind === 'question'
        ? ['Asked a question']
        : event.kind === 'drawings'
          ? ['Showed drawings']
          : event.kind === 'tool_call'
            ? [describeStep(event.name, event.input)]
            : [],
    )
    .slice(-5)
    .reverse();
}

function shownState(
  state: RunState,
  waitingForYou: boolean,
  hasMessages: boolean,
): Shown {
  if (state === 'finished') return 'finished';
  if (state === 'failed') return 'failed';
  if (waitingForYou) return 'waiting';
  if (state === 'active') return 'working';
  return hasMessages && state === 'starting' ? 'working' : 'ready';
}

const stateLabels: Record<Shown, string> = {
  failed: 'Failed',
  finished: 'Finished',
  ready: 'Ready',
  waiting: 'Waiting for your answer',
  working: 'Working',
};

function sentenceOf(shown: Shown, name: string, hasMessages: boolean): string {
  switch (shown) {
    case 'ready':
      return hasMessages
        ? `${name} is ready for your next message.`
        : `${name} is ready for your first message.`;
    case 'working':
      return `${name} is working.`;
    case 'waiting':
      return `${name} is waiting for your answer. It stays ready to continue.`;
    case 'finished':
      return `${name} has finished this conversation.`;
    case 'failed':
      return `${name} stopped unexpectedly.`;
  }
}

function startedText(at: string, now: Date): string {
  const started = new Date(at);
  return started.toDateString() === now.toDateString()
    ? `Today at ${timeOf(at)}`
    : `${started.toLocaleDateString()} at ${timeOf(at)}`;
}

function QuestionForm({
  drawingFor,
  name,
  onAnswer,
  question,
}: {
  /** The drawing a design's drawing section names, when the thread showed it. */
  readonly drawingFor: (section: string) => Drawing | null;
  readonly name: string;
  readonly onAnswer: (answers: Record<string, string>) => Promise<void>;
  readonly question: OpenQuestion;
}): ReactNode {
  const form = useRef<HTMLFormElement>(null);
  const id = useId();
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [own, setOwn] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const single =
    question.questions.length === 1 && !question.questions[0]?.multiSelect;

  useEffect(() => {
    form.current?.focus();
  }, [question.questionId]);

  const answerFor = (item: Question) =>
    own[item.question]?.trim() || chosen[item.question] || '';
  const complete = question.questions.every((item) => answerFor(item) !== '');

  const submit = async (answers: Record<string, string>) => {
    setSending(true);
    try {
      await onAnswer(answers);
    } finally {
      setSending(false);
    }
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!complete || sending) return;
    void submit(
      Object.fromEntries(
        question.questions.map((item) => [item.question, answerFor(item)]),
      ),
    );
  };

  const outcome =
    question.questions.length === 1 && question.questions[0] !== undefined
      ? parseOutcomeQuestion(question.questions[0])
      : null;
  if (outcome !== null && question.questions[0] !== undefined) {
    return (
      <OutcomeForm
        name={name}
        onAnswer={(answer) =>
          submit({ [question.questions[0]!.question]: answer })
        }
        outcome={outcome}
        questionId={question.questionId}
        sending={sending}
      />
    );
  }

  const design =
    question.questions.length === 1 && question.questions[0] !== undefined
      ? parseDesignQuestion(question.questions[0])
      : null;
  if (design !== null && question.questions[0] !== undefined) {
    return (
      <DesignForm
        design={design}
        drawing={drawingFor(design.sections['The drawing'])}
        name={name}
        onAnswer={(answer) =>
          submit({ [question.questions[0]!.question]: answer })
        }
        questionId={question.questionId}
        sending={sending}
      />
    );
  }

  return (
    <form
      aria-labelledby={`${id}-title`}
      className="rounded-2xl border border-[var(--accent)] bg-[var(--surface)] p-4 shadow-sm outline-none focus-visible:ring-3 focus-visible:ring-[var(--focus)]"
      onSubmit={onSubmit}
      ref={form}
      tabIndex={-1}
    >
      {question.questions.map((item, index) => (
        <fieldset
          className={index > 0 ? 'mt-5' : undefined}
          key={item.question}
        >
          <legend
            className="font-bold"
            id={index === 0 ? `${id}-title` : undefined}
          >
            {item.question}
          </legend>
          {index === 0 ? (
            <p className="mt-1 text-sm text-[var(--muted)]">
              {`${name} needs one answer before it can continue.`}
            </p>
          ) : null}
          <div className="mt-3 flex flex-wrap gap-2">
            {item.options.map((option) => (
              <button
                aria-pressed={chosen[item.question] === option.label}
                className="secondary-button text-sm aria-pressed:border-[var(--accent)] aria-pressed:text-[var(--accent)]"
                disabled={sending}
                key={option.label}
                onClick={() => {
                  if (single) {
                    void submit({ [item.question]: option.label });
                    return;
                  }
                  setChosen((previous) => ({
                    ...previous,
                    [item.question]: option.label,
                  }));
                }}
                title={option.description || undefined}
                type="button"
              >
                {option.label}
              </button>
            ))}
          </div>
          <label className="auth-label" htmlFor={`${id}-own-${index}`}>
            Or write your own answer
          </label>
          <input
            className="auth-input"
            id={`${id}-own-${index}`}
            onChange={(event) =>
              setOwn((previous) => ({
                ...previous,
                [item.question]: event.target.value,
              }))
            }
            value={own[item.question] ?? ''}
          />
        </fieldset>
      ))}
      <div className="mt-4 flex justify-end">
        <button
          className="primary-button"
          disabled={!complete || sending}
          type="submit"
        >
          Send
        </button>
      </div>
    </form>
  );
}

const routeOrder: readonly OutcomeRoute[] = ['design', 'build'];

/** The groomer's outcome and the two ways out of grooming (spec §6.3). */
function OutcomeForm({
  name,
  onAnswer,
  outcome,
  questionId,
  sending,
}: {
  readonly name: string;
  readonly onAnswer: (answer: string) => Promise<void>;
  readonly outcome: OutcomeQuestion;
  readonly questionId: string;
  readonly sending: boolean;
}): ReactNode {
  const form = useRef<HTMLFormElement>(null);
  const id = useId();
  const [own, setOwn] = useState('');

  useEffect(() => {
    form.current?.focus();
  }, [questionId]);

  return (
    <form
      aria-labelledby={`${id}-title`}
      className="rounded-2xl border border-[var(--accent)] bg-[var(--surface)] p-4 shadow-sm outline-none focus-visible:ring-3 focus-visible:ring-[var(--focus)]"
      onSubmit={(event) => {
        event.preventDefault();
        if (own.trim() === '' || sending) return;
        void onAnswer(own.trim());
      }}
      ref={form}
      tabIndex={-1}
    >
      <h2 className="font-bold" id={`${id}-title`}>
        {outcome.title || outcomeTitle}
      </h2>
      <p className="mt-1 text-sm text-[var(--muted)]">
        {`${name} needs one answer before it can continue.`}
      </p>
      <OutcomeSectionsView sections={outcome.sections} />
      <div className="mt-3 flex flex-col gap-2">
        {routeOrder.map((route) => {
          const choice = routeChoices[route];
          return (
            <button
              className="secondary-button w-full text-left text-sm"
              disabled={sending}
              key={route}
              onClick={() => void onAnswer(choice.label)}
              type="button"
            >
              <b>{choice.label}</b>
              {` — ${choice.description}`}
              {outcome.recommended === route
                ? ` (recommended by ${name})`
                : null}
            </button>
          );
        })}
      </div>
      <label className="auth-label" htmlFor={`${id}-own`}>
        Or write your own answer
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

/** The designer's write-up of the agreed experience, confirmed or changed (spec §6.3). */
function DesignForm({
  design,
  drawing,
  name,
  onAnswer,
  questionId,
  sending,
}: {
  readonly design: DesignQuestion;
  readonly drawing: Drawing | null;
  readonly name: string;
  readonly onAnswer: (answer: string) => Promise<void>;
  readonly questionId: string;
  readonly sending: boolean;
}): ReactNode {
  const form = useRef<HTMLFormElement>(null);
  const id = useId();
  const [own, setOwn] = useState('');

  useEffect(() => {
    form.current?.focus();
  }, [questionId]);

  return (
    <form
      aria-labelledby={`${id}-title`}
      className="rounded-2xl border border-[var(--accent)] bg-[var(--surface)] p-4 shadow-sm outline-none focus-visible:ring-3 focus-visible:ring-[var(--focus)]"
      onSubmit={(event) => {
        event.preventDefault();
        if (own.trim() === '' || sending) return;
        void onAnswer(own.trim());
      }}
      ref={form}
      tabIndex={-1}
    >
      <h2 className="font-bold" id={`${id}-title`}>
        {confirmDesignTitle}
      </h2>
      <p className="mt-1 text-sm text-[var(--muted)]">
        {`${name} needs one answer before it can continue.`}
      </p>
      <DesignSectionsView
        drawing={drawing}
        name={name}
        sections={design.sections}
      />
      <button
        className="secondary-button mt-3 w-full text-left text-sm"
        disabled={sending}
        onClick={() => void onAnswer(confirmDesignLabel)}
        type="button"
      >
        <b>{confirmDesignLabel}</b>
      </button>
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

/** The newest refused outcome, while nothing has moved since and the run can still act on Try again. */
function retryKeyOf(
  items: readonly ThreadItem[],
  live: boolean,
): string | null {
  if (!live) return null;
  for (const item of [...items].reverse()) {
    const moved = outcomeMoveOf(item);
    if (moved === null) continue;
    return moved ? null : item.key;
  }
  return null;
}

export function ConversationPage({
  client = browserConversationClient,
  now = () => new Date(),
  onBack,
  onOpenItem,
  onTryAgain,
  runId,
}: {
  readonly client?: ConversationClient;
  readonly now?: () => Date;
  readonly onBack: () => void;
  /** Opens an item an agent filed, on its project's board. */
  readonly onOpenItem?: (projectId: string, itemId: string) => void;
  /** Starts a new conversation with the same assistant. */
  readonly onTryAgain: (agentId: string) => Promise<void>;
  readonly runId: string;
}): ReactNode {
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<string[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [confirmingStop, setConfirmingStop] = useState(false);
  const composer = useRef<HTMLTextAreaElement>(null);
  const thread = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const stopButton = useRef<HTMLButtonElement>(null);
  const keepWorking = useRef<HTMLButtonElement>(null);
  const id = useId();

  const load = useCallback(async () => {
    setLoadFailed(false);
    try {
      setConversation(await client.read(runId));
    } catch {
      setLoadFailed(true);
    }
  }, [client, runId]);

  useEffect(() => {
    setConversation(null);
    void load();
  }, [load]);

  const loaded = conversation !== null;
  const lastPosition = useRef(0);
  lastPosition.current = conversation?.events.at(-1)?.position ?? 0;

  useEffect(() => {
    if (!loaded) return undefined;
    return client.subscribe(
      runId,
      lastPosition.current,
      (update: RunUpdate) => {
        setConversation((previous) => {
          if (previous === null) return previous;
          if (update.type === 'state') {
            return {
              ...previous,
              run: {
                ...previous.run,
                failure: update.failure,
                state: update.state,
              },
            };
          }
          if (update.position <= (previous.events.at(-1)?.position ?? 0)) {
            return previous;
          }
          const record: RecordedEvent = {
            createdAt: update.createdAt,
            event: update.event,
            position: update.position,
          };
          return { ...previous, events: [...previous.events, record] };
        });
        if (update.type === 'event' && update.event.kind === 'user_message') {
          const text = update.event.text;
          setPending((previous) => {
            const index = previous.indexOf(text);
            return index === -1
              ? previous
              : [...previous.slice(0, index), ...previous.slice(index + 1)];
          });
        }
      },
    );
  }, [client, loaded, runId]);

  // An open question's form takes focus itself; otherwise the composer does.
  const formShown = useRef(false);
  formShown.current =
    conversation !== null &&
    conversation.run.state !== 'finished' &&
    conversation.run.state !== 'failed' &&
    (openQuestionOf(conversation.events) !== null ||
      hasOpenPlan(conversation.events) ||
      hasOpenDrawings(conversation.events));

  useEffect(() => {
    if (loaded && !formShown.current) composer.current?.focus();
  }, [loaded]);

  useLayoutEffect(() => {
    const element = thread.current;
    if (element !== null && following.current) {
      element.scrollTop = element.scrollHeight;
    }
  });

  useEffect(() => {
    if (confirmingStop) keepWorking.current?.focus();
  }, [confirmingStop]);

  if (loadFailed) {
    return (
      <section className="card" role="alert">
        <p className="font-bold">Couldn’t load this conversation.</p>
        <p className="mt-1 text-[var(--muted)]">
          Your messages are safe. Try again in a moment.
        </p>
        <button
          className="primary-button mt-4"
          onClick={() => void load()}
          type="button"
        >
          Try again
        </button>
      </section>
    );
  }
  if (conversation === null) {
    return <p className="text-[var(--muted)]">Loading the conversation…</p>;
  }

  const { events, run } = conversation;
  const name = run.agentName ?? 'The assistant';
  const role =
    run.agentRole !== null && run.agentRole in roleNames
      ? roleNames[run.agentRole as AgentRole]
      : 'Assistant';
  const roleLine = run.item === null ? role : `${role} · ${run.item.title}`;
  const items = buildThread(events);
  const hasMessages = items.length > 0 || pending.length > 0;
  const question = openQuestionOf(events);
  const planOpen = hasOpenPlan(events);
  const drawingsOpen = hasOpenDrawings(events);
  const shown = shownState(
    run.state,
    question !== null || planOpen || drawingsOpen,
    hasMessages,
  );
  const live = shown !== 'finished' && shown !== 'failed';
  const activity = activityOf(events);
  const newestAssistant = [...items]
    .reverse()
    .find((item) => item.kind === 'assistant');
  const stillWorkingKey =
    shown === 'working' && newestAssistant !== undefined
      ? newestAssistant.key
      : null;

  const retryKey = retryKeyOf(items, live);
  const { projectId } = run;
  const threadActions = {
    onOpenItem:
      onOpenItem === undefined || projectId === null
        ? undefined
        : (itemId: string) => onOpenItem(projectId, itemId),
    onAnswerPlan: async (
      planId: number,
      verdict: PlanVerdict,
      text: string,
    ) => {
      following.current = true;
      await client.answerPlan(runId, planId, verdict, text);
    },
    onAnswerDrawings: async (drawingsId: string, reply: DrawingsReply) => {
      setProblem(null);
      following.current = true;
      try {
        await client.answerDrawings(runId, drawingsId, reply);
      } catch (error) {
        setProblem(
          error instanceof ConversationRequestError && error.status === 409
            ? error.message
            : 'Cerebra couldn’t send that answer. Try again.',
        );
      }
    },
    onRetryOutcome: () => void sendText('Try again.', false),
    planTitle: run.item?.title ?? '',
    retryKey,
  };

  const sendDraft = async () => {
    const text = draft;
    if (text.trim() === '') return;
    setDraft('');
    await sendText(text, true);
  };

  const sendText = async (text: string, restoreDraft: boolean) => {
    setProblem(null);
    setPending((previous) => [...previous, text]);
    following.current = true;
    try {
      await client.send(runId, text);
    } catch {
      setPending((previous) => previous.filter((entry) => entry !== text));
      if (restoreDraft) setDraft(text);
      setProblem('Cerebra couldn’t send that message. Try again.');
    }
  };

  const onComposerKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void sendDraft();
    }
  };

  const answer = async (answers: Record<string, string>) => {
    if (question === null) return;
    setProblem(null);
    following.current = true;
    try {
      await client.answer(runId, question.questionId, answers);
    } catch {
      setProblem('Cerebra couldn’t send that answer. Try again.');
    }
  };

  const closeStop = () => {
    setConfirmingStop(false);
    stopButton.current?.focus();
  };

  const stop = async () => {
    closeStop();
    setProblem(null);
    try {
      await client.stop(runId);
    } catch {
      setProblem(`Cerebra couldn’t stop ${name}. Try again.`);
    }
  };

  const tryAgain = async () => {
    if (run.agentId === null) return;
    setProblem(null);
    try {
      await onTryAgain(run.agentId);
    } catch {
      setProblem(`${name} couldn’t start.`);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <button className={`${link} self-start`} onClick={onBack} type="button">
        Back to fleet
      </button>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <section
          aria-labelledby={`${id}-name`}
          className="flex min-h-[32rem] flex-col rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-sm"
        >
          <header className="flex items-center gap-3 border-b border-[var(--border)] p-4">
            <span
              aria-hidden="true"
              className="grid size-10 shrink-0 place-items-center rounded-xl bg-[var(--accent-muted)] font-extrabold text-[var(--accent)]"
            >
              {name.charAt(0).toUpperCase()}
            </span>
            <div className="min-w-0 flex-1">
              <h1 className="break-words font-extrabold" id={`${id}-name`}>
                {name}
              </h1>
              <p className="break-words text-sm text-[var(--muted)]">
                {roleLine}
              </p>
            </div>
            <p
              className={`rounded-full px-3 py-1 text-sm font-bold ${
                shown === 'failed'
                  ? 'bg-red-50 text-[var(--danger)] dark:bg-red-950'
                  : 'bg-[var(--accent-muted)] text-[var(--accent)]'
              }`}
              role="status"
            >
              {stateLabels[shown]}
            </p>
          </header>
          <div
            className="flex max-h-[60vh] min-h-64 flex-1 flex-col gap-3 overflow-y-auto p-4"
            data-testid="thread"
            onScroll={(event) => {
              const element = event.currentTarget;
              following.current =
                element.scrollHeight -
                  element.scrollTop -
                  element.clientHeight <
                40;
            }}
            ref={thread}
          >
            {!hasMessages && live ? (
              <div className="m-auto text-center">
                <h2 className="text-lg font-bold">Start the conversation</h2>
                <p className="mt-1 text-[var(--muted)]">
                  {`Send ${name} a message to begin.`}
                </p>
              </div>
            ) : null}
            <ThreadView
              actions={threadActions}
              items={items}
              live={live}
              name={name}
              stillWorkingKey={stillWorkingKey}
            />
            {pending.map((text, index) => (
              <article
                className="max-w-[85%] self-end rounded-2xl bg-[var(--accent-muted)] p-3 opacity-80"
                key={`pending-${index}`}
              >
                <p className="whitespace-pre-wrap break-words">{text}</p>
                <p className="mt-1 text-xs text-[var(--muted)]">You</p>
              </article>
            ))}
            {question !== null && live ? (
              <QuestionForm
                drawingFor={(section) => drawingNamed(items, section)}
                name={name}
                onAnswer={answer}
                question={question}
              />
            ) : null}
            {shown === 'finished' ? (
              <section className="rounded-2xl border border-[var(--border)] p-4">
                <h2 className="font-bold">Conversation finished</h2>
                <p className="mt-1 text-[var(--muted)]">
                  {`${name} has finished this conversation. Its messages and activity stay here for you to review.`}
                </p>
                <button
                  className="secondary-button mt-3"
                  onClick={onBack}
                  type="button"
                >
                  Back to fleet
                </button>
              </section>
            ) : null}
            {shown === 'failed' ? (
              <section className="rounded-2xl border border-[var(--danger)] bg-red-50 p-4 dark:bg-red-950">
                <h2 className="font-bold text-[var(--danger)]">
                  {`${name} stopped unexpectedly`}
                </h2>
                <p className="mt-1">
                  {`The conversation ended before ${name} could finish. Your messages and its activity are still here.`}
                </p>
                <div className="mt-3 flex flex-wrap gap-3">
                  {run.agentId !== null ? (
                    <button
                      className="primary-button"
                      onClick={() => void tryAgain()}
                      type="button"
                    >
                      Try again
                    </button>
                  ) : null}
                  <button
                    className="secondary-button"
                    onClick={onBack}
                    type="button"
                  >
                    Back to fleet
                  </button>
                </div>
              </section>
            ) : null}
          </div>
          {problem !== null ? (
            <p className="auth-error mx-4" role="alert">
              {problem}
            </p>
          ) : null}
          {live ? (
            <form
              className="border-t border-[var(--border)] p-4"
              onSubmit={(event) => {
                event.preventDefault();
                void sendDraft();
              }}
            >
              <textarea
                aria-label={`Message ${name}`}
                className="auth-input mt-0 min-h-20 resize-y"
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={onComposerKey}
                placeholder={`Message ${name}`}
                ref={composer}
                value={draft}
              />
              <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm text-[var(--muted)]">
                  {hasMessages
                    ? `You can send a message while ${name} is working.`
                    : 'Send a message to start.'}
                </p>
                <button className="primary-button" type="submit">
                  Send message
                </button>
              </div>
            </form>
          ) : null}
        </section>
        <aside
          aria-labelledby={`${id}-panel`}
          className="hidden self-start rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 text-sm shadow-sm lg:block"
        >
          <h2 className="font-bold" id={`${id}-panel`}>
            Conversation
          </h2>
          <p className="mt-1 text-[var(--muted)]">
            {sentenceOf(shown, name, hasMessages)}
          </p>
          {live ? (
            <button
              className="secondary-button mt-3 w-full text-[var(--danger)]"
              onClick={() => setConfirmingStop(true)}
              ref={stopButton}
              type="button"
            >
              Stop conversation
            </button>
          ) : null}
          <dl className="mt-4 space-y-3">
            <div>
              <dt className="font-bold">Started</dt>
              <dd className="text-[var(--muted)]">
                {startedText(run.startedAt, now())}
              </dd>
            </div>
            <div>
              <dt className="font-bold">Working on</dt>
              <dd className="break-words text-[var(--muted)]">
                {run.item?.title ?? 'No work item attached'}
              </dd>
            </div>
          </dl>
          {activity.length > 0 ? (
            <>
              <h3 className="mt-4 font-bold">Activity</h3>
              <ul className="mt-1 space-y-1 text-[var(--muted)]">
                {activity.map((line, index) => (
                  <li className="break-words" key={`${index}-${line}`}>
                    {line}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </aside>
      </div>
      {confirmingStop ? (
        <div
          aria-labelledby={`${id}-stop`}
          aria-modal="true"
          className="fixed inset-0 z-20 grid place-items-center bg-black/40 p-5"
          onKeyDown={(event) => trapFocus(event, closeStop)}
          role="dialog"
        >
          <section className="card w-full max-w-md">
            <h2 className="text-xl font-bold" id={`${id}-stop`}>
              {`Stop ${name}?`}
            </h2>
            <p className="mt-2 text-[var(--muted)]">
              {`${name} will stop now. This conversation will stay available to read, but ${name} will not continue until you start a new conversation.`}
            </p>
            <div className="mt-6 flex flex-wrap justify-end gap-3">
              <button
                className="secondary-button"
                onClick={closeStop}
                ref={keepWorking}
                type="button"
              >
                Keep working
              </button>
              <button
                className="primary-button bg-[var(--danger)]"
                onClick={() => void stop()}
                type="button"
              >
                {`Stop ${name}`}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
