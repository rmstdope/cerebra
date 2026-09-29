import { expect, test, vi } from 'vitest';

import { loadMasterKey } from './master-key.js';

const key = Buffer.alloc(32, 7).toString('base64');

test('loads and validates a mounted Podman secret, allowing its final newline', async () => {
  const read = vi.fn(async () => `${key}\n`);
  expect(
    await loadMasterKey(
      { CEREBRA_PROJECT_TOKEN_KEY_FILE: '/run/secrets/key' },
      read,
    ),
  ).toBe(key);
  expect(read).toHaveBeenCalledWith('/run/secrets/key', 'utf8');
});

test('keeps legacy environment-only deployments working', async () => {
  expect(await loadMasterKey({ CEREBRA_PROJECT_TOKEN_KEY: key })).toBe(key);
  expect(await loadMasterKey({})).toBeUndefined();
});

test('rejects ambiguous key sources instead of silently changing keys', async () => {
  await expect(
    loadMasterKey({
      CEREBRA_PROJECT_TOKEN_KEY: key,
      CEREBRA_PROJECT_TOKEN_KEY_FILE: '/run/secrets/key',
    }),
  ).rejects.toThrow('either');
});

test('fails closed on unreadable secrets without leaking underlying errors', async () => {
  await expect(
    loadMasterKey(
      { CEREBRA_PROJECT_TOKEN_KEY_FILE: '/run/secrets/key' },
      async () => {
        throw new Error(`private detail ${key}`);
      },
    ),
  ).rejects.toThrow('Cannot read');
});

test.each(['', 'invalid-secret-value', `${key}extra`])(
  'rejects malformed secret %j without exposing it',
  async (value) => {
    await expect(
      loadMasterKey(
        { CEREBRA_PROJECT_TOKEN_KEY_FILE: '/run/secrets/key' },
        async () => value,
      ),
    ).rejects.toThrow('base64-encoded 32-byte key');
  },
);
