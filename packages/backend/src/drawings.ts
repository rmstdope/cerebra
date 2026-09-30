import { randomUUID } from 'node:crypto';

import type { Drawing } from '@cerebra/shared';

import type { RunNote } from './plan-approvals.js';

/** The navigator's answer to a round of drawings: the chosen label, or else the written change. */
export interface DrawingsAnswer {
  readonly choice: string | null;
  readonly text: string;
}

export interface DrawingsRound {
  readonly question: string;
  readonly drawings: readonly Drawing[];
}

export type DrawingsAnswerErrorCode = 'invalid' | 'not_waiting';

/** An answer that cannot be taken, with the words the round shows. */
export class DrawingsAnswerError extends Error {
  constructor(
    readonly code: DrawingsAnswerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DrawingsAnswerError';
  }
}

export const drawingsNotWaitingMessage =
  'These drawings are no longer waiting for you.';

/**
 * The designer's drawings question (spec §6.3): a round waits here until the navigator chooses a
 * drawing or says what to change. One round waits per run, in memory — a backend restart fails
 * live runs, so nothing outlives the process — and a newer round withdraws the older.
 */
export interface DrawingQuestions {
  /** Shows the round in the run's conversation and waits for the navigator's answer. */
  ask(
    runId: string,
    round: DrawingsRound,
    signal?: AbortSignal,
  ): Promise<DrawingsAnswer>;
  /**
   * Shows the question and how many drawings are on their way (spec §6.4), before any can be
   * shown; nothing can be answered until the set is shown.
   */
  prepare(
    runId: string,
    round: { readonly question: string; readonly count: number },
    signal?: AbortSignal,
  ): Promise<PreparingRound>;
  answer(runId: string, input: unknown): Promise<DrawingsAnswer>;
}

/** A set of drawings on its way: shown whole once it arrives, or withdrawn if it is refused. */
export interface PreparingRound {
  readonly drawingsId: string;
  /** Shows the arrived set in place of the preparing question and waits, as `ask` does. */
  show(drawings: readonly Drawing[]): Promise<DrawingsAnswer>;
  /** Takes the preparing question away: the set was refused, and nothing of it is shown. */
  withdraw(): Promise<void>;
}

interface Waiting {
  readonly drawingsId: string;
  readonly labels: readonly string[];
  readonly settle: (answer: DrawingsAnswer) => void;
  /** Whether the asking call still waits: neither answered nor withdrawn. */
  readonly open: () => boolean;
  /** Resolves once the withdrawal is in the conversation. */
  readonly withdraw: (reason: unknown) => Promise<void>;
}

function answerFrom(
  input: unknown,
): DrawingsAnswer & { readonly drawingsId: string } {
  const fields =
    typeof input === 'object' && input !== null
      ? (input as Record<string, unknown>)
      : {};
  const { choice, drawingsId, text } = fields;
  if (typeof drawingsId !== 'string' || drawingsId === '') {
    throw new DrawingsAnswerError(
      'invalid',
      'Name the drawings you are answering.',
    );
  }
  if (typeof choice === 'string' && text === undefined) {
    return { choice, drawingsId, text: '' };
  }
  const said = typeof text === 'string' ? text.trim() : '';
  if (choice !== undefined || said === '') {
    throw new DrawingsAnswerError(
      'invalid',
      'Choose a drawing or say what to change.',
    );
  }
  return { choice: null, drawingsId, text: said };
}

function checkRound(round: DrawingsRound): void {
  const labels = round.drawings.map((drawing) => drawing.label);
  if (labels.length === 0) {
    throw new Error('A round needs at least one drawing.');
  }
  if (new Set(labels).size !== labels.length) {
    throw new Error('Each drawing of a round needs its own label.');
  }
}

export function createDrawingQuestions({
  note,
}: {
  readonly note: RunNote;
}): DrawingQuestions {
  const waiting = new Map<string, Waiting>();
  /** Each run's set on its way, by how it is withdrawn. */
  const onItsWay = new Map<string, () => Promise<void>>();

  // The older round's withdrawal lands before the newer round, so the chat reads in order.
  async function withdrawOlder(runId: string): Promise<void> {
    // A set on its way that cannot be withdrawn belongs to a run that is ending anyway.
    await onItsWay
      .get(runId)?.()
      .catch(() => {});
    await waiting
      .get(runId)
      ?.withdraw(new Error('A newer round of drawings replaced this one.'));
  }

  /** Shows a round under `drawingsId` and waits for its answer or its withdrawal. */
  async function wait(
    runId: string,
    drawingsId: string,
    round: DrawingsRound,
    signal: AbortSignal | undefined,
  ): Promise<DrawingsAnswer> {
    const noted = note(
      runId,
      { kind: 'drawings', drawingsId, ...round },
      'awaiting_input',
    );
    let aborted = () => {};
    let open = true;
    const answered = new Promise<DrawingsAnswer>((resolve, reject) => {
      const release = () => {
        signal?.removeEventListener('abort', aborted);
        if (waiting.get(runId)?.drawingsId === drawingsId) {
          waiting.delete(runId);
        }
      };
      const withdraw = (reason: unknown) => {
        open = false;
        release();
        reject(reason);
        // The withdrawal follows the round's note, so it can never land before it.
        return noted
          .then(() =>
            note(runId, { kind: 'drawings_withdrawn', drawingsId }, 'active'),
          )
          .catch(() => undefined);
      };
      aborted = () => {
        void withdraw(signal?.reason ?? new Error('The call was abandoned.'));
      };
      waiting.set(runId, {
        drawingsId,
        labels: round.drawings.map((drawing) => drawing.label),
        open: () => open,
        settle: (answer) => {
          open = false;
          release();
          resolve(answer);
        },
        withdraw,
      });
      signal?.addEventListener('abort', aborted, { once: true });
    });
    // A withdrawal can reject the answer before anything awaits it; the caller still sees it.
    answered.catch(() => undefined);
    try {
      await noted;
    } catch (error) {
      signal?.removeEventListener('abort', aborted);
      if (waiting.get(runId)?.drawingsId === drawingsId) {
        waiting.delete(runId);
      }
      throw error;
    }
    return answered;
  }

  return {
    async ask(runId, round, signal) {
      signal?.throwIfAborted();
      checkRound(round);
      await withdrawOlder(runId);
      signal?.throwIfAborted();
      return wait(runId, randomUUID(), round, signal);
    },

    async prepare(runId, { count, question }, signal) {
      signal?.throwIfAborted();
      if (!Number.isInteger(count) || count < 1) {
        throw new Error('A round needs at least one drawing.');
      }
      await withdrawOlder(runId);
      signal?.throwIfAborted();
      const drawingsId = randomUUID();
      let stage: 'preparing' | 'shown' | 'withdrawn' = 'preparing';
      let withdrawing: Promise<void> | null = null;
      const announced = note(
        runId,
        { count, drawingsId, kind: 'drawings_preparing', question },
        'active',
      );
      const forget = () => {
        signal?.removeEventListener('abort', abandoned);
        if (onItsWay.get(runId) === withdraw) onItsWay.delete(runId);
      };
      // One withdrawal, however many ask for it, written after the set was announced; the set
      // stays on its way until it is written, so a newer round waits for it.
      const withdraw = (): Promise<void> => {
        if (stage === 'shown') return Promise.resolve();
        stage = 'withdrawn';
        withdrawing ??= (async () => {
          try {
            await announced;
            await note(
              runId,
              { drawingsId, kind: 'drawings_withdrawn' },
              'active',
            );
          } finally {
            forget();
          }
        })();
        return withdrawing;
      };
      // An abandoned call leaves nothing on its way; a failed note is the run ending anyway.
      const abandoned = () => void withdraw().catch(() => {});
      onItsWay.set(runId, withdraw);
      signal?.addEventListener('abort', abandoned, { once: true });
      try {
        await announced;
      } catch (error) {
        stage = 'withdrawn';
        forget();
        throw error;
      }
      return {
        drawingsId,
        async show(drawings) {
          if (stage !== 'preparing') {
            throw new Error('This set of drawings is no longer on its way.');
          }
          const round = { drawings, question };
          try {
            checkRound(round);
            if (drawings.length !== count) {
              throw new Error(
                `The set holds ${drawings.length} drawings, not the ${count} prepared.`,
              );
            }
            signal?.throwIfAborted();
          } catch (error) {
            await withdraw().catch(() => {});
            throw error;
          }
          stage = 'shown';
          forget();
          return wait(runId, drawingsId, round, signal);
        },
        withdraw,
      };
    },

    async answer(runId, input) {
      const answer = answerFrom(input);
      const round = waiting.get(runId);
      if (round === undefined || round.drawingsId !== answer.drawingsId) {
        throw new DrawingsAnswerError('not_waiting', drawingsNotWaitingMessage);
      }
      if (answer.choice !== null && !round.labels.includes(answer.choice)) {
        throw new DrawingsAnswerError(
          'invalid',
          'Choose one of the drawings shown.',
        );
      }
      // Taken at once, so a second answer to the same round is refused.
      waiting.delete(runId);
      const settled = { choice: answer.choice, text: answer.text };
      try {
        await note(
          runId,
          {
            kind: 'drawings_answer',
            drawingsId: answer.drawingsId,
            ...settled,
          },
          'active',
        );
      } catch (error) {
        // Unwritten, the answer never happened: the round waits again, so the navigator can retry.
        if (round.open() && !waiting.has(runId)) waiting.set(runId, round);
        throw error;
      }
      round.settle(settled);
      return settled;
    },
  };
}
