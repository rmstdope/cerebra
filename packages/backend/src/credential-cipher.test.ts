import { randomBytes } from 'node:crypto';
import { describe, expect, test } from 'vitest';

import { createEnvelopeCipher } from './credential-cipher.js';

const masterKey = randomBytes(32).toString('base64');

describe('envelope cipher', () => {
  test('opens what it sealed', () => {
    const cipher = createEnvelopeCipher(masterKey);

    expect(cipher.open(cipher.seal('ghp_secret'))).toBe('ghp_secret');
  });

  test('seals every value under its own data key, never in plain text', () => {
    const cipher = createEnvelopeCipher(masterKey);

    const first = cipher.seal('ghp_secret');
    const second = cipher.seal('ghp_secret');

    expect(first.keyCiphertext).not.toBe(second.keyCiphertext);
    expect(first.valueCiphertext).not.toBe(second.valueCiphertext);
    expect(JSON.stringify(first)).not.toContain('ghp_secret');
    expect(JSON.stringify(first)).not.toContain(
      Buffer.from('ghp_secret').toString('base64'),
    );
  });

  test('refuses a tampered value', () => {
    const cipher = createEnvelopeCipher(masterKey);
    const sealed = cipher.seal('ghp_secret');
    const bytes = Buffer.from(sealed.valueCiphertext, 'base64');
    bytes[0] = bytes[0]! ^ 1;

    expect(() =>
      cipher.open({ ...sealed, valueCiphertext: bytes.toString('base64') }),
    ).toThrow();
  });

  test('refuses a value sealed under another master key', () => {
    const sealed = createEnvelopeCipher(masterKey).seal('ghp_secret');
    const other = createEnvelopeCipher(randomBytes(32).toString('base64'));

    expect(() => other.open(sealed)).toThrow();
  });

  test('rejects a master key that is not 32 base64 bytes', () => {
    expect(() => createEnvelopeCipher('short')).toThrow(
      'CEREBRA_PROJECT_TOKEN_KEY must be a base64-encoded 32-byte key.',
    );
  });
});
