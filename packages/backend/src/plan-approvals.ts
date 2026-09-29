import type { AgentEvent, PlanVerdict } from '@cerebra/shared';
import type { Kysely } from 'kysely';

import { liveRunStates, type Database, type RunState } from './database.js';
import { isUuid } from './runs.js';

/** The navigator's answer to a builder's plan (spec §4.9). */
export interface PlanAnswer {
  readonly verdict: PlanVerdict;
  /** What should change; empty for an approval. */
  readonly text: string;
}

/** Appends an event the backend wrote to a live run's conversation, and sets its state. */
export type RunNote = (
  runId: string,
  event: AgentEvent,
  state: Extract<RunState, 'active' | 'awaiting_input'>,
) => Promise<void>;

export type PlanAnswerErrorCode = 'invalid' | 'not_found' | 'not_waiting';

/** An answer that cannot be taken, with the words the plan card shows. */
export class PlanAnswerError extends Error {
  constructor(
    readonly code: PlanAnswerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PlanAnswerError';
  }
}

export const emptyChangesMessage =
  'Say what should change so the builder can revise the plan.';
export const planNotWaitingMessage = 'This plan is no longer waiting for you.';

/**
 * The plan checkpoint (spec §4.9): a builder's `submit_plan` waits here until the navigator
 * answers in the builder's conversation. The answer is kept as a `plan_answer` record, so the
 * lifecycle can tell whether the latest plan may be built on.
 */
export interface PlanApprovals {
  /** Shows the plan in the run's conversation and waits for the navigator's answer. */
  await(
    runId: string,
    plan: { readonly id: number; readonly markdown: string },
    signal?: AbortSignal,
  ): Promise<PlanAnswer>;
  answer(runId: string, input: unknown): Promise<PlanAnswer>;
}

function answerFrom(input: unknown): PlanAnswer & { readonly planId: number } {
  const fields =
    typeof input === 'object' && input !== null
      ? (input as Record<string, unknown>)
      : {};
  const { planId, verdict, text } = fields;
  if (typeof planId !== 'number' || !Number.isSafeInteger(planId)) {
    throw new PlanAnswerError('invalid', 'Name the plan you are answering.');
  }
  if (verdict !== 'approved' && verdict !== 'changes') {
    throw new PlanAnswerError(
      'invalid',
      'Approve the plan or ask for changes.',
    );
  }
  const said = typeof text === 'string' ? text.trim() : '';
  if (verdict === 'changes' && said === '') {
    throw new PlanAnswerError('invalid', emptyChangesMessage);
  }
  return { planId, text: verdict === 'approved' ? '' : said, verdict };
}

export function createPlanApprovals({
  database,
  note,
}: {
  readonly database: Kysely<Database>;
  readonly note: RunNote;
}): PlanApprovals {
  const waiting = new Map<number, (answer: PlanAnswer) => void>();

  return {
    async await(runId, plan, signal) {
      signal?.throwIfAborted();
      const answered = new Promise<PlanAnswer>((resolve, reject) => {
        const aborted = () => {
          waiting.delete(plan.id);
          reject(signal?.reason ?? new Error('The call was abandoned.'));
        };
        waiting.set(plan.id, (answer) => {
          signal?.removeEventListener('abort', aborted);
          waiting.delete(plan.id);
          resolve(answer);
        });
        signal?.addEventListener('abort', aborted, { once: true });
      });
      try {
        await note(
          runId,
          { kind: 'plan_approval', markdown: plan.markdown, planId: plan.id },
          'awaiting_input',
        );
      } catch (error) {
        waiting.delete(plan.id);
        throw error;
      }
      return answered;
    },

    async answer(runId, input) {
      const answer = answerFrom(input);
      if (!isUuid(runId)) {
        throw new PlanAnswerError('not_found', `Run ${runId} was not found.`);
      }
      await database.transaction().execute(async (transaction) => {
        const run = await transaction
          .selectFrom('runs')
          .select('status')
          .where('id', '=', runId)
          .executeTakeFirst();
        if (run === undefined) {
          throw new PlanAnswerError('not_found', `Run ${runId} was not found.`);
        }
        const item = (liveRunStates as readonly RunState[]).includes(run.status)
          ? await transaction
              .selectFrom('work_items')
              .select(['id', 'state'])
              .where('holder_run_id', '=', runId)
              .forUpdate()
              .executeTakeFirst()
          : undefined;
        if (item === undefined || item.state !== 'building') {
          throw new PlanAnswerError('not_waiting', planNotWaitingMessage);
        }
        const records = await transaction
          .selectFrom('work_item_records')
          .select(['id', 'kind', 'payload'])
          .where('work_item_id', '=', item.id)
          .where('run_id', '=', runId)
          .where('kind', 'in', ['plan', 'plan_answer'])
          .orderBy('id', 'desc')
          .execute();
        const newest = records.find((record) => record.kind === 'plan');
        const needsAnswer =
          newest !== undefined &&
          Number(newest.id) === answer.planId &&
          (newest.payload as { approval?: unknown }).approval === 'required' &&
          !records.some(
            (record) =>
              record.kind === 'plan_answer' &&
              (record.payload as { planId?: unknown }).planId === answer.planId,
          );
        if (!needsAnswer) {
          throw new PlanAnswerError('not_waiting', planNotWaitingMessage);
        }
        await transaction
          .insertInto('work_item_records')
          .values({
            kind: 'plan_answer',
            payload: JSON.stringify({
              kind: 'plan_answer',
              planId: answer.planId,
              text: answer.text,
              verdict: answer.verdict,
            }),
            run_id: runId,
            work_item_id: item.id,
          })
          .execute();
      });
      const settled = { text: answer.text, verdict: answer.verdict };
      try {
        await note(
          runId,
          { kind: 'plan_answer', planId: answer.planId, ...settled },
          'active',
        );
      } finally {
        waiting.get(answer.planId)?.(settled);
      }
      return settled;
    },
  };
}
