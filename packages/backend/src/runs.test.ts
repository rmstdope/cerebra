import { describe, expect, test } from 'vitest';

import { createRunStore } from './runs.js';
import {
  agentNamed,
  registerTestProject,
  withTestDatabase,
} from './test-support.js';

describe('the run store', { concurrent: false }, () => {
  test('a new run starts, records its events in order and reads back as a conversation', async () => {
    await withTestDatabase(async (database) => {
      const projectId = await registerTestProject(database);
      const agentId = await agentNamed(database, projectId, 'Cerebro');
      const runs = createRunStore(database);

      const run = await runs.create({
        agentId,
        agentName: 'Cerebro',
        projectId,
        role: 'assistant',
        tokenHash: 'hash-1',
      });
      expect(run).toMatchObject({ agentId, projectId, state: 'starting' });

      await runs.append(run.id, { kind: 'user_message', text: 'Hello' });
      await runs.append(run.id, { kind: 'message', text: 'Hi there' });
      expect(await runs.setState(run.id, 'active')).toBe(true);

      const conversation = await runs.read(run.id);
      expect(conversation).toMatchObject({
        run: {
          agentName: 'Cerebro',
          id: run.id,
          item: null,
          role: 'assistant',
          state: 'active',
        },
        events: [
          { event: { kind: 'user_message', text: 'Hello' }, position: 1 },
          { event: { kind: 'message', text: 'Hi there' }, position: 2 },
        ],
      });
      expect(await runs.read(crypto.randomUUID())).toBeNull();
    });
  });

  test('only a live run is found by its token, and ending it twice changes nothing', async () => {
    await withTestDatabase(async (database) => {
      const projectId = await registerTestProject(database);
      const agentId = await agentNamed(database, projectId, 'Cerebro');
      const runs = createRunStore(database);
      const run = await runs.create({
        agentId,
        agentName: 'Cerebro',
        projectId,
        role: 'assistant',
        tokenHash: 'hash-2',
      });

      expect(await runs.byTokenHash('hash-2')).toMatchObject({ id: run.id });
      expect((await runs.liveFor(agentId))?.id).toBe(run.id);

      expect(
        await runs.end(run.id, {
          failure: 'The runner never connected.',
          reason: 'The run failed.',
          state: 'failed',
        }),
      ).toBe(true);
      expect(
        await runs.end(run.id, { reason: 'Again.', state: 'finished' }),
      ).toBe(false);
      expect(await runs.setState(run.id, 'active')).toBe(false);

      expect(await runs.byTokenHash('hash-2')).toBeNull();
      expect(await runs.liveFor(agentId)).toBeNull();
      expect((await runs.read(run.id))?.run).toMatchObject({
        failure: 'The runner never connected.',
        state: 'failed',
      });
      expect((await runs.read(run.id))?.run.endedAt).toBeInstanceOf(Date);
    });
  });

  test('the conversation keeps its name after the agent is removed', async () => {
    await withTestDatabase(async (database) => {
      const projectId = await registerTestProject(database);
      const agentId = await agentNamed(database, projectId, 'Cerebro');
      const runs = createRunStore(database);
      const run = await runs.create({
        agentId,
        agentName: 'Cerebro',
        projectId,
        role: 'assistant',
        tokenHash: 'hash-3',
      });
      await runs.end(run.id, { reason: 'Stopped.', state: 'finished' });
      await database.deleteFrom('agents').where('id', '=', agentId).execute();

      expect((await runs.read(run.id))?.run).toMatchObject({
        agentId: null,
        agentName: 'Cerebro',
      });
    });
  });

  test('ending a run that holds an item gives it back with its last message', async () => {
    await withTestDatabase(async (database) => {
      const projectId = await registerTestProject(database);
      const agentId = await agentNamed(database, projectId, 'Storm');
      const runs = createRunStore(database);
      const run = await runs.create({
        agentId,
        agentName: 'Storm',
        projectId,
        role: 'builder',
        tokenHash: 'hash-4',
      });
      const itemId = crypto.randomUUID();
      await database
        .insertInto('work_items')
        .values({
          attempts: 0,
          description: '',
          holder_run_id: run.id,
          id: itemId,
          priority: 'P1',
          project_id: projectId,
          rounds: 0,
          state: 'building',
          title: 'Share reports',
        })
        .execute();
      await runs.append(run.id, { kind: 'message', text: 'First try.' });
      await runs.append(run.id, { kind: 'message', text: 'Tests are red.' });
      expect((await runs.read(run.id))?.run.item).toEqual({
        id: itemId,
        title: 'Share reports',
      });

      await runs.end(run.id, {
        failure: 'The runner disconnected.',
        reason: 'The run failed: The runner disconnected.',
        state: 'failed',
      });

      expect(
        await database
          .selectFrom('work_items')
          .select(['state', 'attempts', 'holder_run_id'])
          .where('id', '=', itemId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ attempts: 1, holder_run_id: null, state: 'build_ready' });
      // A run that no longer holds its item still names it, and its project.
      expect((await runs.read(run.id))?.run).toMatchObject({
        item: { id: itemId, title: 'Share reports' },
        projectId,
      });
      expect(
        await database
          .selectFrom('work_item_comments')
          .select('body')
          .where('work_item_id', '=', itemId)
          .execute(),
      ).toEqual([{ body: 'Tests are red.' }]);
      expect(
        await database
          .selectFrom('work_item_history')
          .select(['actor_role', 'actor_run_id', 'reason', 'to_state'])
          .where('work_item_id', '=', itemId)
          .execute(),
      ).toEqual([
        {
          actor_role: 'backend',
          actor_run_id: run.id,
          reason: 'The run failed: The runner disconnected.',
          to_state: 'build_ready',
        },
      ]);
    });
  });

  test('the ending that reaches max_attempts escalates the item', async () => {
    await withTestDatabase(async (database) => {
      const projectId = await registerTestProject(database);
      await database
        .updateTable('projects')
        .set({ max_attempts: 2 })
        .where('id', '=', projectId)
        .execute();
      const agentId = await agentNamed(database, projectId, 'Storm');
      const runs = createRunStore(database);
      const run = await runs.create({
        agentId,
        agentName: 'Storm',
        projectId,
        role: 'builder',
        tokenHash: 'hash-5',
      });
      const itemId = crypto.randomUUID();
      await database
        .insertInto('work_items')
        .values({
          attempts: 1,
          description: '',
          holder_run_id: run.id,
          id: itemId,
          priority: 'P1',
          project_id: projectId,
          rounds: 0,
          state: 'building',
          title: 'Share reports',
        })
        .execute();

      await runs.end(run.id, {
        reason: 'The navigator stopped the run.',
        state: 'finished',
      });

      expect(
        await database
          .selectFrom('work_items')
          .select(['state', 'attempts', 'waiting_kind', 'return_state'])
          .where('id', '=', itemId)
          .executeTakeFirstOrThrow(),
      ).toEqual({
        attempts: 2,
        return_state: 'build_ready',
        state: 'waiting',
        waiting_kind: 'escalation',
      });
    });
  });

  test('usage adds up and the latest run of an agent tells whether it failed to start', async () => {
    await withTestDatabase(async (database) => {
      const projectId = await registerTestProject(database);
      const agentId = await agentNamed(database, projectId, 'Cerebro');
      const runs = createRunStore(database);
      const run = await runs.create({
        agentId,
        agentName: 'Cerebro',
        projectId,
        role: 'assistant',
        tokenHash: 'hash-6',
      });
      await runs.addUsage(run.id, { costUsd: 0.25, sessionId: 'session-1' });
      await runs.addUsage(run.id, { costUsd: 0.5 });
      await runs.end(run.id, {
        failure: 'No model credential.',
        reason: 'The run could not start.',
        startFailed: true,
        state: 'failed',
      });

      const row = await database
        .selectFrom('runs')
        .select(['cost_usd', 'session_id', 'start_failed'])
        .where('id', '=', run.id)
        .executeTakeFirstOrThrow();
      expect(row).toEqual({
        cost_usd: 0.75,
        session_id: 'session-1',
        start_failed: true,
      });
      expect((await runs.live()).map((live) => live.id)).toEqual([]);
    });
  });
});
