import { describe, expect, test } from 'vitest';

import { createInputQueue } from './input-queue.js';

describe('the input queue', () => {
  test('yields what was pushed, in order, including what arrives while it waits', async () => {
    const queue = createInputQueue<string>();
    queue.push('first');
    const seen: string[] = [];
    const reading = (async () => {
      for await (const item of queue) {
        seen.push(item);
      }
    })();

    await Promise.resolve();
    queue.push('second');
    queue.push('third');
    queue.close();
    await reading;

    expect(seen).toEqual(['first', 'second', 'third']);
  });

  test('ends a waiting reader when closed, and refuses a push afterwards', async () => {
    const queue = createInputQueue<number>();
    const next = queue[Symbol.asyncIterator]().next();

    queue.close();

    await expect(next).resolves.toEqual({ done: true, value: undefined });
    expect(() => queue.push(1)).toThrow('The input queue is closed');
  });
});
