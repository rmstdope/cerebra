export interface InputQueue<T> extends AsyncIterable<T> {
  push(item: T): void;
  /** Ends the iteration once what was already pushed has been read. */
  close(): void;
}

/** A push queue read as an async iterable: the SDK's prompt in streaming-input mode. */
export function createInputQueue<T>(): InputQueue<T> {
  const items: T[] = [];
  let closed = false;
  let wake: (() => void) | undefined;

  function signal(): void {
    const resume = wake;
    wake = undefined;
    resume?.();
  }

  return {
    push(item) {
      if (closed) {
        throw new Error('The input queue is closed');
      }
      items.push(item);
      signal();
    },
    close() {
      closed = true;
      signal();
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (items.length > 0) {
          yield items.shift() as T;
        } else if (closed) {
          return;
        } else {
          await new Promise<void>((resolve) => (wake = resolve));
        }
      }
    },
  };
}
