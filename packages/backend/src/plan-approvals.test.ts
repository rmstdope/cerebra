import type { AgentEvent } from '@cerebra/shared';
import type { Kysely } from 'kysely';
import { describe, expect, test } from 'vitest';

import type { Database } from './database.js';
import { createPlanApprovals } from './plan-approvals.js';

describe('plan approvals', () => {
  test('withdraws a plan abandoned while it is still being shown only after it is shown', async () => {
    const written: { event: AgentEvent; state: string }[] = [];
    let shown = () => {};
    const plans = createPlanApprovals({
      database: {} as Kysely<Database>,
      note: async (_runId, event, state) => {
        if (event.kind === 'plan_approval') {
          await new Promise<void>((resolve) => (shown = resolve));
        }
        written.push({ event, state });
      },
    });
    const abandon = new AbortController();

    const call = plans.await(
      'run',
      { id: 7, markdown: '# Plan' },
      abandon.signal,
    );
    abandon.abort(new Error('The runner hung up.'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(written).toEqual([]);
    shown();

    await expect(call).rejects.toThrow('The runner hung up.');
    await expect.poll(() => written.length).toBe(2);
    expect(written).toEqual([
      {
        event: { kind: 'plan_approval', markdown: '# Plan', planId: 7 },
        state: 'awaiting_input',
      },
      { event: { kind: 'plan_withdrawn', planId: 7 }, state: 'active' },
    ]);
  });
});
