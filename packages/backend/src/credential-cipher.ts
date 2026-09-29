import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { decodeMasterKey } from './project-token.js';

export interface SealedValue {
  readonly keyCiphertext: string;
  readonly keyIv: string;
  readonly keyTag: string;
  readonly valueCiphertext: string;
  readonly valueIv: string;
  readonly valueTag: string;
}

export interface EnvelopeCipher {
  open(sealed: SealedValue): string;
  seal(value: string): SealedValue;
}

interface Encrypted {
  readonly ciphertext: string;
  readonly iv: string;
  readonly tag: string;
}

function encrypt(key: Buffer, plaintext: Buffer): Encrypted {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

function decrypt(key: Buffer, encrypted: Encrypted): Buffer {
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(encrypted.iv, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, 'base64')),
    decipher.final(),
  ]);
}

export function createEnvelopeCipher(encodedMasterKey: string): EnvelopeCipher {
  const masterKey = decodeMasterKey(encodedMasterKey);

  return {
    open(sealed) {
      const dataKey = decrypt(masterKey, {
        ciphertext: sealed.keyCiphertext,
        iv: sealed.keyIv,
        tag: sealed.keyTag,
      });
      try {
        return decrypt(dataKey, {
          ciphertext: sealed.valueCiphertext,
          iv: sealed.valueIv,
          tag: sealed.valueTag,
        }).toString('utf8');
      } finally {
        dataKey.fill(0);
      }
    },
    seal(value) {
      const dataKey = randomBytes(32);
      try {
        const sealedValue = encrypt(dataKey, Buffer.from(value, 'utf8'));
        const sealedKey = encrypt(masterKey, dataKey);
        return {
          keyCiphertext: sealedKey.ciphertext,
          keyIv: sealedKey.iv,
          keyTag: sealedKey.tag,
          valueCiphertext: sealedValue.ciphertext,
          valueIv: sealedValue.iv,
          valueTag: sealedValue.tag,
        };
      } finally {
        dataKey.fill(0);
      }
    },
  };
}
