import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test } from 'vitest';

import type { BoardClient } from './board';
import { ProjectBoard } from './project-board';

afterEach(cleanup);

const workItem = {
  createdAt: '2026-09-29T00:00:00.000Z',
  description: 'Make the board easy to use.',
  id: 'item-1',
  priority: null,
  state: 'new',
  title: 'Show the board',
  updatedAt: '2026-09-29T00:00:00.000Z',
};

function createClient(): BoardClient {
  return {
    addComment: async () => ({
      body: 'A comment',
      createdAt: '2026-09-29T00:00:00.000Z',
      id: 1,
    }),
    cancel: async () => ({ ...workItem, state: 'cancelled' }),
    comments: async () => [],
    create: async (_projectId, input) => ({
      ...workItem,
      description: input.description,
      id: 'item-2',
      title: input.title,
    }),
    history: async () => [],
    list: async () => [workItem],
    triage: async (_itemId, priority, route) => ({
      ...workItem,
      priority,
      state: route,
    }),
  };
}

test('files work and triages the selected work item', async () => {
  const user = userEvent.setup();
  render(<ProjectBoard boardClient={createClient()} projectId="project-1" />);

  expect((await screen.findAllByText('Show the board')).length).toBeGreaterThan(
    0,
  );
  await user.click(screen.getByRole('button', { name: 'Add work item' }));
  await user.type(
    screen.getByLabelText('What needs to change?'),
    'Keep the board stable',
  );
  await user.click(screen.getAllByRole('button', { name: 'Add work item' })[1]);

  expect(
    await screen.findByRole('heading', { name: 'Keep the board stable' }),
  ).toBeTruthy();
  await user.click(screen.getAllByText('Show the board')[0]);
  await user.selectOptions(screen.getByLabelText('Priority'), 'P1');
  await user.selectOptions(
    screen.getByLabelText('Where should this go next?'),
    'build_ready',
  );
  await user.click(
    screen.getByRole('button', { name: 'Set priority and continue' }),
  );

  expect(await screen.findAllByText('Build Ready')).not.toHaveLength(0);
});

test('shows the agreed honest empty state', async () => {
  render(
    <ProjectBoard
      boardClient={{ ...createClient(), list: async () => [] }}
      projectId="project-1"
    />,
  );

  expect(
    await screen.findByText(
      'Nothing is on this board yet. Add your first work item to get started.',
    ),
  ).toBeTruthy();
});
