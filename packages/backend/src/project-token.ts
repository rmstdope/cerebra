import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface EncryptedProjectToken {
  readonly ciphertext: string;
  readonly iv: string;
  readonly tag: string;
}

export interface ProjectTokenCipher {
  decrypt(token: EncryptedProjectToken): string;
  encrypt(token: string): EncryptedProjectToken;
}

const invalidKeyMessage =
  'CEREBRA_PROJECT_TOKEN_KEY must be a base64-encoded 32-byte key.';

export function decodeMasterKey(encodedKey: string): Buffer {
  const key = Buffer.from(encodedKey, 'base64');
  if (key.length !== 32 || key.toString('base64') !== encodedKey) {
    throw new Error(invalidKeyMessage);
  }
  return key;
}

export function createProjectTokenCipher(
  encodedKey: string,
): ProjectTokenCipher {
  const key = decodeMasterKey(encodedKey);

  return {
    decrypt(token) {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        key,
        Buffer.from(token.iv, 'base64'),
      );
      decipher.setAuthTag(Buffer.from(token.tag, 'base64'));
      return Buffer.concat([
        decipher.update(Buffer.from(token.ciphertext, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    },
    encrypt(token) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const ciphertext = Buffer.concat([
        cipher.update(token, 'utf8'),
        cipher.final(),
      ]);
      return {
        ciphertext: ciphertext.toString('base64'),
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
      };
    },
  };
}
