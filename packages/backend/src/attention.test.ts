import type { Kysely } from 'kysely';
import { describe, expect, test } from 'vitest';

import { createAttention } from './attention.js';
import { createBoard } from './board.js';
import type { Database, RunState } from './database.js';
import { createNavigatorQueue } from './navigator-queue.js';
import {
  agentNamed,
  registerTestProject,
  withTestDatabase,
} from './test-support.js';

async function addRun(
  database: Kysely<Database>,
  run: {
    agentId: string | null;
    agentName: string;
    at: string;
    projectId: string;
    status: RunState;
  },
): Promise<string> {
  const id = crypto.randomUUID();
  await database
    .insertInto('runs')
    .values({
      agent_id: run.agentId,
      agent_name: run.agentName,
      created_at: new Date(run.at),
      ended_at: run.status === 'failed' ? new Date(run.at) : null,
      id,
      project_id: run.projectId,
      role: 'builder',
      status: run.status,
    })
    .execute();
  return id;
}

function attentionFor(database: Kysely<Database>) {
  return createAttention(database, createNavigatorQueue(database));
}

describe('what needs the navigator', { concurrent: false }, () => {
  test('lists open questions, waiting work and failed runs, but not new work', async () => {
    await withTestDatabase(async (database) => {
      const projectId = await registerTestProject(database);
      const board = createBoard(database);
      await board.createWorkItem({
        id: crypto.randomUUID(),
        projectId,
        title: 'Just filed',
      });
      const waitingId = crypto.randomUUID();
      await board.createWorkItem({
        id: waitingId,
        priority: 'P1',
        projectId,
        state: 'build_ready',
        title: 'Share reports',
      });
      const waited = await board.transition(waitingId, {
        actor: { role: 'backend' },
        to: 'waiting',
        waiting: {
          kind: 'escalation',
          reason: 'The build keeps failing.',
          returnState: 'build_ready',
        },
      });
      expect(waited.ok).toBe(true);
      const asking = await addRun(database, {
        agentId: await agentNamed(database, projectId, 'Cerebro'),
        agentName: 'Cerebro',
        at: '2026-10-01T09:00:00Z',
        projectId,
        status: 'awaiting_input',
      });
      await database
        .insertInto('run_events')
        .values({
          event: JSON.stringify({
            kind: 'question',
            questionId: 'q1',
            questions: [
              {
                header: '',
                multiSelect: false,
                options: [],
                question: 'Which release?',
              },
            ],
          }),
          position: 1,
          run_id: asking,
        })
        .execute();
      const agentId = await agentNamed(database, projectId, 'Storm');
      const failed = await addRun(database, {
        agentId,
        agentName: 'Storm',
        at: '2026-10-01T08:00:00Z',
        projectId,
        status: 'failed',
      });

      const entries = await attentionFor(database).list();

      expect(entries).toHaveLength(3);
      expect(entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            agentName: 'Cerebro',
            kind: 'question',
            projectId,
            projectName: 'acme/website',
            runId: asking,
            title: 'Which release?',
          }),
          expect.objectContaining({
            id: waitingId,
            itemId: waitingId,
            kind: 'waiting',
            runId: null,
            title: 'Share reports',
          }),
          expect.objectContaining({
            agentName: 'Storm',
            id: `trouble:${failed}`,
            kind: 'trouble',
            runId: failed,
            since: new Date('2026-10-01T08:00:00Z'),
            title: 'A run stopped before it could finish',
          }),
        ]),
      );
      const times = entries.map((entry) => entry.since.getTime());
      expect(times).toEqual([...times].sort((a, b) => b - a));
    });
  });

  test('a failed run stops being trouble once its agent runs again or is removed', async () => {
    await withTestDatabase(async (database) => {
      const projectId = await registerTestProject(database);
      const storm = await agentNamed(database, projectId, 'Storm');
      await addRun(database, {
        agentId: storm,
        agentName: 'Storm',
        at: '2026-10-01T08:00:00Z',
        projectId,
        status: 'failed',
      });
      await addRun(database, {
        agentId: storm,
        agentName: 'Storm',
        at: '2026-10-01T09:00:00Z',
        projectId,
        status: 'finished',
      });
      await addRun(database, {
        agentId: null,
        agentName: 'Removed',
        at: '2026-10-01T10:00:00Z',
        projectId,
        status: 'failed',
      });

      expect(await attentionFor(database).list()).toEqual([]);
    });
  });
});
