import { expect, test } from 'vitest';

import { createProjectTokenCipher } from './project-token.js';

test('encrypts project tokens with authenticated encryption', () => {
  const cipher = createProjectTokenCipher(
    Buffer.alloc(32, 7).toString('base64'),
  );

  const encrypted = cipher.encrypt('github-token');

  expect(encrypted.ciphertext).not.toContain('github-token');
  expect(cipher.decrypt(encrypted)).toBe('github-token');
  expect(() =>
    cipher.decrypt({ ...encrypted, tag: Buffer.alloc(16).toString('base64') }),
  ).toThrow();
});

test('rejects a missing or invalid project-token master key', () => {
  expect(() => createProjectTokenCipher('not-a-key')).toThrow(
    'CEREBRA_PROJECT_TOKEN_KEY must be a base64-encoded 32-byte key.',
  );
});
