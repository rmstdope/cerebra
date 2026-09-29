import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { AttentionEntry } from './attention.js';
import { createNotifier, createPushBatcher } from './notifier.js';

function entry(
  id: string,
  overrides: Partial<AttentionEntry> = {},
): AttentionEntry {
  return {
    agentName: 'Storm',
    id,
    itemId: null,
    kind: 'question',
    projectId: 'project-1',
    projectName: 'acme/website',
    runId: `run-${id}`,
    since: new Date('2026-10-01T09:00:00Z'),
    title: `Question ${id}`,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the push batcher', () => {
  test('pushes within thirty seconds of the first are sent as one batch', () => {
    const send = vi.fn();
    const batcher = createPushBatcher({ send });

    batcher.push([entry('a')]);
    vi.advanceTimersByTime(10_000);
    batcher.push([entry('b')]);
    vi.advanceTimersByTime(19_999);
    batcher.push([entry('c')]);
    expect(send).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0].map((e: AttentionEntry) => e.id)).toEqual([
      'a',
      'b',
      'c',
    ]);

    batcher.push([entry('d')]);
    vi.advanceTimersByTime(30_000);
    expect(send).toHaveBeenCalledTimes(2);
  });

  test('an empty push opens no window, and stopping drops what is pending', () => {
    const send = vi.fn();
    const batcher = createPushBatcher({ send });

    batcher.push([]);
    vi.advanceTimersByTime(30_000);
    batcher.push([entry('a')]);
    batcher.stop();
    vi.advanceTimersByTime(30_000);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('the notifier', () => {
  function setup(initial: AttentionEntry[] = []) {
    let entries = initial;
    let muted = new Set<string>();
    const notifier = createNotifier({
      attention: { list: async () => entries },
      settings: { mutedProjects: async () => muted },
    });
    const received: unknown[] = [];
    const tab = notifier.connect((message) => received.push(message));
    return {
      notifier,
      received,
      setEntries: (next: AttentionEntry[]) => {
        entries = next;
      },
      setMuted: (next: string[]) => {
        muted = new Set(next);
      },
      tab,
    };
  }

  test('what was already there when it started is never pushed', async () => {
    const { notifier, received } = setup([entry('a')]);

    await notifier.poll();
    await notifier.poll();
    vi.advanceTimersByTime(30_000);

    expect(received).toEqual([]);
  });

  test('something new is pushed once to every open tab, after the window', async () => {
    const { notifier, received, setEntries } = setup([entry('a')]);
    const other: unknown[] = [];
    notifier.connect((message) => other.push(message));
    await notifier.poll();

    setEntries([entry('a'), entry('b')]);
    await notifier.poll();
    await notifier.poll();
    vi.advanceTimersByTime(30_000);

    const push = { entries: [entry('b')], type: 'push' };
    expect(received).toEqual([push]);
    expect(other).toEqual([push]);
  });

  test('a muted project is not pushed, and unmuting it does not push the past', async () => {
    const { notifier, received, setEntries, setMuted } = setup();
    await notifier.poll();
    setMuted(['project-1']);

    setEntries([entry('a')]);
    await notifier.poll();
    setMuted([]);
    await notifier.poll();
    vi.advanceTimersByTime(30_000);

    expect(received).toEqual([]);
  });

  test('a question in the chat a tab is looking at is not pushed', async () => {
    const { notifier, received, setEntries, tab } = setup();
    await notifier.poll();
    tab.focus('run-a');

    setEntries([entry('a'), entry('b')]);
    await notifier.poll();
    vi.advanceTimersByTime(30_000);

    expect(received).toEqual([{ entries: [entry('b')], type: 'push' }]);
  });

  test('a closed tab receives nothing, and its focus no longer suppresses', async () => {
    const { notifier, received, setEntries, tab } = setup();
    const other: unknown[] = [];
    notifier.connect((message) => other.push(message));
    await notifier.poll();
    tab.focus('run-a');
    tab.close();

    setEntries([entry('a')]);
    await notifier.poll();
    vi.advanceTimersByTime(30_000);

    expect(received).toEqual([]);
    expect(other).toEqual([{ entries: [entry('a')], type: 'push' }]);
  });

  test('an entry that resolves and returns is pushed again', async () => {
    const { notifier, received, setEntries } = setup();
    await notifier.poll();
    setEntries([entry('a')]);
    await notifier.poll();
    setEntries([]);
    await notifier.poll();
    setEntries([entry('a')]);
    await notifier.poll();
    vi.advanceTimersByTime(30_000);
    // Within one window it is one thing to look at.
    expect(received).toEqual([{ entries: [entry('a')], type: 'push' }]);

    setEntries([]);
    await notifier.poll();
    setEntries([entry('a')]);
    await notifier.poll();
    vi.advanceTimersByTime(30_000);
    expect(received).toHaveLength(2);
  });
});
