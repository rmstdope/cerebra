import {
  act,
  cleanup,
  fireEvent,
  render as renderPlain,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, expect, test, vi } from 'vitest';

import { mockupEscapeMessage, type Drawing } from '@cerebra/shared';

import { DrawingCards, DrawingsRoundView } from './drawing-cards';
import type { DrawingsItem } from './conversation-thread';
import { MockupLocatorContext, type LocateMockup } from './mockups';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const served = (id: string) => `http://localhost:4318/mockups/${id}`;

function render(
  ui: ReactElement,
  locate: LocateMockup = async (id) => served(id),
) {
  return renderPlain(
    <MockupLocatorContext.Provider value={locate}>
      {ui}
    </MockupLocatorContext.Provider>,
  );
}

const card = (index: number) => screen.getAllByRole('listitem')[index]!;

const drawings: readonly Drawing[] = [
  {
    cost: 'Always visible; takes toolbar room.',
    label: 'A · Button in the toolbar',
    recommended: true,
    mockupId: 'mockup-a',
  },
  {
    cost: 'Tidier; one extra click.',
    label: 'B · Inside the ⋯ menu',
    recommended: false,
    mockupId: null,
  },
  {
    cost: 'Hard to miss.',
    label: 'C · Floating button',
    recommended: false,
    mockupId: 'mockup-c',
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

test('a drawing that loaded stays shown past twenty seconds', async () => {
  vi.useFakeTimers();
  render(<DrawingCards drawings={[drawings[0]!]} name="Iris" />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  fireEvent.load(card(0).querySelector('iframe')!);

  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });
  expect(card(0).querySelector('iframe')).not.toBeNull();
  expect(
    within(card(0)).queryByText('This drawing couldn’t be shown.'),
  ).toBeNull();
});

test('Tab reaches the live drawing between the dialog controls', async () => {
  const user = userEvent.setup();
  render(<DrawingCards drawings={drawings} name="Iris" onChoose={vi.fn()} />);
  await user.click(
    within(card(0)).getByRole('button', { name: 'Open full size' }),
  );
  const dialog = screen.getByRole('dialog');
  const frame = await waitFor(() => {
    const found = dialog.querySelector('iframe');
    expect(found).not.toBeNull();
    return found!;
  });
  fireEvent.load(frame);

  within(dialog).getByRole('button', { name: 'Close' }).focus();
  await user.tab();
  expect(document.activeElement).toBe(frame);

  within(dialog).getByRole('button', { name: '‹ Previous' }).focus();
  await user.tab({ shift: true });
  expect(document.activeElement).toBe(frame);
});

test('focus stays inside full size', async () => {
  const user = userEvent.setup();
  render(<DrawingCards drawings={drawings} name="Iris" onChoose={vi.fn()} />);
  await user.click(
    within(screen.getAllByRole('listitem')[1]!).getByRole('button', {
      name: 'Open full size',
    }),
  );
  const dialog = screen.getByRole('dialog');
  const last = await within(dialog).findByRole('button', {
    name: 'Try again',
  });
  last.focus();

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

test('a card previews its drawing as a still picture Tab never enters', async () => {
  const { container } = render(
    <DrawingCards drawings={drawings} name="Iris" onChoose={vi.fn()} />,
  );

  const frame = await waitFor(() => {
    const found = card(0).querySelector('iframe');
    expect(found).not.toBeNull();
    return found!;
  });
  expect(frame.getAttribute('src')).toBe(served('mockup-a'));
  expect(frame.getAttribute('sandbox')).toBe('');
  expect(frame.hasAttribute('inert')).toBe(true);
  expect(frame.getAttribute('tabindex')).toBe('-1');
  expect(frame.getAttribute('aria-hidden')).toBe('true');
  expect(container.querySelectorAll('[aria-busy="true"]')).toHaveLength(2);

  fireEvent.load(frame);
  expect(card(0).querySelector('[aria-busy="true"]')).toBeNull();
  expect(within(card(0)).getByText('A · Button in the toolbar')).toBeTruthy();
});

test('clicking a card preview opens that drawing full size', async () => {
  const user = userEvent.setup();
  render(<DrawingCards drawings={drawings} name="Iris" onChoose={vi.fn()} />);
  const preview = await waitFor(() => {
    const found = card(2).querySelector<HTMLElement>('.cursor-zoom-in');
    expect(found).not.toBeNull();
    return found!;
  });

  await user.click(preview);
  expect(
    screen.getByRole('dialog', { name: 'C · Floating button' }),
  ).toBeTruthy();
});

test('a card whose drawing is not found says so and tries again on request', async () => {
  const user = userEvent.setup();
  const locate = vi
    .fn<LocateMockup>()
    .mockRejectedValueOnce(new Error('Request failed with status 404.'))
    .mockImplementation(async (id) => served(id));
  render(
    <DrawingCards drawings={[drawings[0]!]} name="Iris" onChoose={vi.fn()} />,
    locate,
  );

  const retry = await within(card(0)).findByRole('button', {
    name: 'Try again',
  });
  expect(
    within(card(0)).getByText('This drawing couldn’t be shown.'),
  ).toBeTruthy();
  expect(card(0).querySelector('iframe')).toBeNull();
  expect(
    within(card(0)).getByRole('button', { name: 'Open full size' }),
  ).toBeTruthy();

  await user.click(retry);
  const frame = await waitFor(() => {
    const found = card(0).querySelector('iframe');
    expect(found).not.toBeNull();
    return found!;
  });
  expect(card(0).querySelector('[aria-busy="true"]')).not.toBeNull();
  expect(locate).toHaveBeenCalledTimes(2);
  fireEvent.load(frame);
  expect(
    within(card(0)).queryByText('This drawing couldn’t be shown.'),
  ).toBeNull();
});

test('a drawing with nothing stored fails without asking where it is', async () => {
  const locate = vi.fn<LocateMockup>();
  render(<DrawingCards drawings={[drawings[1]!]} name="Iris" />, locate);

  expect(
    await within(card(0)).findByRole('button', { name: 'Try again' }),
  ).toBeTruthy();
  expect(locate).not.toHaveBeenCalled();
});

test('a drawing that never finishes loading fails after twenty seconds', async () => {
  vi.useFakeTimers();
  render(<DrawingCards drawings={[drawings[0]!]} name="Iris" />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(19_000);
  });
  expect(card(0).querySelector('iframe')).not.toBeNull();
  expect(
    within(card(0)).queryByText('This drawing couldn’t be shown.'),
  ).toBeNull();

  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
  expect(
    within(card(0)).getByText('This drawing couldn’t be shown.'),
  ).toBeTruthy();
  expect(card(0).querySelector('iframe')).toBeNull();
});

test('full size runs the drawing live and closes when Escape is pressed inside it', async () => {
  const user = userEvent.setup();
  render(<DrawingCards drawings={drawings} name="Iris" onChoose={vi.fn()} />);
  const opener = within(card(0)).getByRole('button', {
    name: 'Open full size',
  });
  await user.click(opener);
  const dialog = screen.getByRole('dialog');
  const frame = await waitFor(() => {
    const found = dialog.querySelector('iframe');
    expect(found).not.toBeNull();
    return found!;
  });
  expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
  expect(frame.getAttribute('title')).toBe('A · Button in the toolbar');
  expect(frame.hasAttribute('inert')).toBe(false);

  fireEvent(
    window,
    new MessageEvent('message', { data: mockupEscapeMessage, source: window }),
  );
  expect(screen.queryByRole('dialog')).not.toBeNull();
  fireEvent(
    window,
    new MessageEvent('message', {
      data: 'something else',
      source: frame.contentWindow,
    }),
  );
  expect(screen.queryByRole('dialog')).not.toBeNull();

  fireEvent(
    window,
    new MessageEvent('message', {
      data: mockupEscapeMessage,
      source: frame.contentWindow,
    }),
  );
  expect(screen.queryByRole('dialog')).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(opener));
});

test('tabbing out of the live drawing lands on the dialog controls', async () => {
  const user = userEvent.setup();
  render(<DrawingCards drawings={drawings} name="Iris" onChoose={vi.fn()} />);
  await user.click(
    within(card(0)).getByRole('button', { name: 'Open full size' }),
  );
  const dialog = screen.getByRole('dialog');
  const sentinel = dialog.querySelector<HTMLElement>('[data-focus-return]');
  expect(sentinel).not.toBeNull();

  act(() => sentinel!.focus());
  expect(document.activeElement).toBe(
    within(dialog).getByRole('button', { name: '‹ Previous' }),
  );
});

test('full size fails with its controls still usable, and tries again', async () => {
  const user = userEvent.setup();
  const locate = vi
    .fn<LocateMockup>()
    .mockImplementationOnce(async (id) => served(id))
    .mockRejectedValueOnce(new Error('Request failed with status 404.'))
    .mockImplementation(async (id) => served(id));
  render(
    <DrawingCards drawings={[drawings[0]!]} name="Iris" onChoose={vi.fn()} />,
    locate,
  );
  await user.click(
    within(card(0)).getByRole('button', { name: 'Open full size' }),
  );
  const dialog = screen.getByRole('dialog');

  const retry = await within(dialog).findByRole('button', {
    name: 'Try again',
  });
  expect(
    within(dialog).getByText('This drawing couldn’t be shown.'),
  ).toBeTruthy();
  for (const name of ['‹ Previous', 'Next ›', 'Choose A', 'Close']) {
    expect(within(dialog).getByRole('button', { name })).toBeTruthy();
  }

  await user.click(retry);
  await waitFor(() => expect(dialog.querySelector('iframe')).not.toBeNull());
  expect(
    within(dialog).queryByText('This drawing couldn’t be shown.'),
  ).toBeNull();
});
