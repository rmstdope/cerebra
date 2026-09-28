import { browserAuthClient } from './auth';
import { afterEach, expect, test, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
});

test('rejects a failed sign-out response', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(undefined, { status: 503 })),
  );

  await expect(browserAuthClient.signOut()).rejects.toThrow(
    'Cerebra couldn’t sign you out. Try again.',
  );
});
