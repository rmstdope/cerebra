import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';

import type { Drawing } from '@cerebra/shared';

import { DrawingCards, DrawingsRoundView } from './drawing-cards';
import type { DrawingsItem } from './conversation-thread';

afterEach(cleanup);

const drawings: readonly Drawing[] = [
  {
    cost: 'Always visible; takes toolbar room.',
    label: 'A · Button in the toolbar',
    recommended: true,
    url: '/drawings/a.html',
  },
  {
    cost: 'Tidier; one extra click.',
    label: 'B · Inside the ⋯ menu',
    recommended: false,
    url: null,
  },
  {
    cost: 'Hard to miss.',
    label: 'C · Floating button',
    recommended: false,
    url: '/drawings/c.html',
  },
];

const round = (status: DrawingsItem['status'] = 'open'): DrawingsItem => ({
  at: '2026-10-01T10:31:00.000Z',
  choice: null,
  drawings,
  drawingsId: 'd-1',
  key: 'drawings-d-1',
  kind: 'drawings',
  question: 'Which export button?',
  status,
});

test('each drawing is a card with its preview, label, cost and recommendation', () => {
  render(<DrawingCards drawings={drawings} name="Iris" onChoose={vi.fn()} />);

  const cards = screen.getAllByRole('listitem');
  expect(cards).toHaveLength(3);
  const first = within(cards[0]!);
  expect(
    first.getByTitle('A · Button in the toolbar').getAttribute('src'),
  ).toBe('/drawings/a.html');
  expect(
    first.getByTitle('A · Button in the toolbar').getAttribute('sandbox'),
  ).toBe('allow-scripts');
  expect(first.getByText('A · Button in the toolbar')).toBeTruthy();
  expect(
    first.getByText(
      'Always visible; takes toolbar room. (recommended by Iris)',
    ),
  ).toBeTruthy();
  expect(first.getByRole('button', { name: 'Open full size' })).toBeTruthy();
  expect(first.getByRole('button', { name: 'Choose A' })).toBeTruthy();
  expect(within(cards[2]!).getByText('Hard to miss.')).toBeTruthy();
});

test('a drawing that cannot be shown says so, and its label and Choose stay usable', async () => {
  const user = userEvent.setup();
  const onChoose = vi.fn();
  render(<DrawingCards drawings={drawings} name="Iris" onChoose={onChoose} />);

  const card = within(screen.getAllByRole('listitem')[1]!);
  expect(card.getByText('This drawing couldn’t be shown.')).toBeTruthy();
  expect(card.getByText('B · Inside the ⋯ menu')).toBeTruthy();
  await user.click(card.getByRole('button', { name: 'Choose B' }));
  expect(onChoose).toHaveBeenCalledWith('B · Inside the ⋯ menu');
});

test('full size shows one drawing at a time, wrapping within the round', async () => {
  const user = userEvent.setup();
  render(<DrawingCards drawings={drawings} name="Iris" onChoose={vi.fn()} />);

  await user.click(
    within(screen.getAllByRole('listitem')[0]!).getByRole('button', {
      name: 'Open full size',
    }),
  );
  const dialog = screen.getByRole('dialog', {
    name: 'A · Button in the toolbar',
  });
  expect(within(dialog).getByText('1 of 3')).toBeTruthy();
  expect(dialog.getAttribute('aria-modal')).toBe('true');

  await user.click(within(dialog).getByRole('button', { name: '‹ Previous' }));
  expect(
    screen.getByRole('dialog', { name: 'C · Floating button' }),
  ).toBeTruthy();
  expect(screen.getByText('3 of 3')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Next ›' }));
  await user.click(screen.getByRole('button', { name: 'Next ›' }));
  const second = screen.getByRole('dialog', { name: 'B · Inside the ⋯ menu' });
  expect(
    within(second).getByText('This drawing couldn’t be shown.'),
  ).toBeTruthy();
  expect(within(second).getByRole('button', { name: 'Choose B' })).toBeTruthy();
});

test('Esc or ✕ closes full size and returns focus to the card it came from', async () => {
  const user = userEvent.setup();
  render(<DrawingCards drawings={drawings} name="Iris" onChoose={vi.fn()} />);
  const openThird = within(screen.getAllByRole('listitem')[2]!).getByRole(
    'button',
    { name: 'Open full size' },
  );

  await user.click(openThird);
  await waitFor(() =>
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(
      true,
    ),
  );
  await user.click(screen.getByRole('button', { name: 'Next ›' }));
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(openThird));

  await user.click(openThird);
  await user.click(screen.getByRole('button', { name: 'Close' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(openThird));
});

test('focus stays inside full size', async () => {
  const user = userEvent.setup();
  render(<DrawingCards drawings={drawings} name="Iris" onChoose={vi.fn()} />);
  await user.click(
    within(screen.getAllByRole('listitem')[0]!).getByRole('button', {
      name: 'Open full size',
    }),
  );
  const dialog = screen.getByRole('dialog');
  const close = within(dialog).getByRole('button', { name: 'Close' });
  close.focus();

  await user.tab();
  expect(dialog.contains(document.activeElement)).toBe(true);
  expect(document.activeElement).toBe(
    within(dialog).getByRole('button', { name: '‹ Previous' }),
  );
});

test('choosing from full size answers and closes it', async () => {
  const user = userEvent.setup();
  const onChoose = vi.fn();
  render(<DrawingCards drawings={drawings} name="Iris" onChoose={onChoose} />);
  await user.click(
    within(screen.getAllByRole('listitem')[2]!).getByRole('button', {
      name: 'Open full size',
    }),
  );

  await user.click(
    within(screen.getByRole('dialog')).getByRole('button', {
      name: 'Choose C',
    }),
  );
  expect(onChoose).toHaveBeenCalledWith('C · Floating button');
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('an earlier round can be viewed full size but not chosen', async () => {
  const user = userEvent.setup();
  render(<DrawingCards drawings={drawings} name="Iris" />);

  expect(screen.queryByRole('button', { name: /^Choose/ })).toBeNull();
  await user.click(
    within(screen.getAllByRole('listitem')[0]!).getByRole('button', {
      name: 'Open full size',
    }),
  );
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).queryByRole('button', { name: /^Choose/ })).toBeNull();
  expect(within(dialog).getByRole('button', { name: 'Next ›' })).toBeTruthy();
});

test('an open round asks for one answer: a drawing, or what to change', async () => {
  const user = userEvent.setup();
  const onAnswer = vi.fn(async () => undefined);
  render(
    <DrawingsRoundView live name="Iris" onAnswer={onAnswer} round={round()} />,
  );

  const form = screen.getByRole('form', { name: 'Which export button?' });
  await waitFor(() => expect(document.activeElement).toBe(form));
  expect(
    within(form).getByText('Iris needs one answer before it can continue.'),
  ).toBeTruthy();
  const send = within(form).getByRole('button', { name: 'Send' });
  expect((send as HTMLButtonElement).disabled).toBe(true);

  await user.click(within(form).getByRole('button', { name: 'Choose A' }));
  expect(onAnswer).toHaveBeenLastCalledWith({
    choice: 'A · Button in the toolbar',
  });

  await user.type(
    within(form).getByLabelText('Or say what to change'),
    'Make the button smaller.',
  );
  await user.click(send);
  expect(onAnswer).toHaveBeenLastCalledWith({
    text: 'Make the button smaller.',
  });
});

test('an answered, superseded or withdrawn round shows its drawings without choosing', () => {
  for (const status of ['answered', 'superseded', 'withdrawn'] as const) {
    render(
      <DrawingsRoundView
        live
        name="Iris"
        onAnswer={vi.fn()}
        round={round(status)}
      />,
    );
    const shown = screen.getByRole('region', { name: 'Which export button?' });
    expect(within(shown).getAllByRole('listitem')).toHaveLength(3);
    expect(within(shown).queryByRole('button', { name: /^Choose/ })).toBeNull();
    expect(within(shown).queryByRole('button', { name: 'Send' })).toBeNull();
    cleanup();
  }
  render(<DrawingsRoundView live={false} name="Iris" round={round()} />);
  expect(screen.queryByRole('button', { name: /^Choose/ })).toBeNull();
});
