import { pathToFileURL } from 'node:url';

import type { Kysely } from 'kysely';

import {
  carryOver,
  CarryOverError,
  CarryOverManifestError,
  parseCarryOverManifest,
} from './carry-over.js';
import { createDatabase, type Database } from './database.js';

/**
 * Carries a manifest over as the navigator's own act, run inside the main container:
 * `podman exec -i images_main_1 node packages/backend/dist/carry-over-cli.js < manifest.json`.
 * Answers the exit code; the database is left open for the caller to close.
 */
export async function runCarryOver({
  database,
  input,
  write,
}: {
  readonly database: Kysely<Database>;
  readonly input: string;
  readonly write: (line: string) => void;
}): Promise<number> {
  let json: unknown;
  try {
    json = JSON.parse(input);
  } catch {
    write('Nothing was carried over: the manifest is not valid JSON.');
    return 1;
  }
  try {
    const manifest = parseCarryOverManifest(json);
    const carried = await carryOver(database, manifest);
    for (const item of carried) {
      write(`${item.oldName} → ${item.key} (${item.state})`);
    }
    write(
      `Carried over ${carried.length} ${carried.length === 1 ? 'item' : 'items'} into ${manifest.project}.`,
    );
    return 0;
  } catch (error) {
    if (
      error instanceof CarryOverError ||
      error instanceof CarryOverManifestError
    ) {
      write(`Nothing was carried over: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const database = createDatabase(process.env.DATABASE_URL ?? '');
  try {
    process.exitCode = await runCarryOver({
      database,
      input: await readStdin(),
      write: (line) => process.stdout.write(`${line}\n`),
    });
  } finally {
    await database.destroy();
  }
}
