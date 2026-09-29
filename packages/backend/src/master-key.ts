import { readFile } from 'node:fs/promises';

import { decodeMasterKey } from './project-token.js';

export async function loadMasterKey(
  environment: NodeJS.ProcessEnv = process.env,
  read: (path: string, encoding: 'utf8') => Promise<string> = readFile,
): Promise<string | undefined> {
  const file = environment.CEREBRA_PROJECT_TOKEN_KEY_FILE;
  const legacy = environment.CEREBRA_PROJECT_TOKEN_KEY;
  if (file !== undefined && legacy !== undefined) {
    throw new Error(
      'Configure either CEREBRA_PROJECT_TOKEN_KEY_FILE or CEREBRA_PROJECT_TOKEN_KEY, not both.',
    );
  }
  let key = legacy;
  if (file !== undefined) {
    try {
      key = (await read(file, 'utf8')).trimEnd();
    } catch {
      throw new Error(
        'Cannot read the master-key secret. Check CEREBRA_PROJECT_TOKEN_KEY_FILE and the Podman secret mount.',
      );
    }
  }
  if (key !== undefined) {
    decodeMasterKey(key).fill(0);
  }
  return key;
}
