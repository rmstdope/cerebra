import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { expect, test } from 'vitest';

import { createBackups, createPgDump } from './backups.js';
import { registerTestProject, withTestDatabase } from './test-support.js';

// The server is Postgres 18 and a client must be at least as new, so the tools run from its image.
const clientImage = 'docker.io/library/postgres:18';
const connectionVariables = [
  'PGHOST',
  'PGPORT',
  'PGUSER',
  'PGPASSWORD',
  'PGDATABASE',
];
function postgresTool(tool: string): string[] {
  return [
    'podman',
    'run',
    '--rm',
    '--interactive',
    '--network=host',
    ...connectionVariables.flatMap((name) => ['--env', name]),
    clientImage,
    tool,
  ];
}

function connection(databaseUrl: string, database: string) {
  const url = new URL(databaseUrl);
  return {
    PGDATABASE: database,
    PGHOST: url.hostname,
    PGPASSWORD: decodeURIComponent(url.password),
    PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username),
  };
}

test('a produced backup restores the records it was taken from', async () => {
  const databaseUrl = process.env.DATABASE_URL ?? '';
  const directory = await mkdtemp(join(tmpdir(), 'cerebra-restore-'));
  const restored = `cerebra_restore_${crypto.randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: databaseUrl });
  try {
    await withTestDatabase(async (database) => {
      const schema = (
        await database
          .selectNoFrom((builder) =>
            builder.fn<string>('current_schema').as('schema'),
          )
          .executeTakeFirstOrThrow()
      ).schema;
      const projectId = await registerTestProject(database, 'website');
      const backups = createBackups({
        config: {
          directory,
          keep: 7,
          location: directory,
          time: { hour: 2, minute: 0 },
        },
        database,
        dump: createPgDump({
          command: postgresTool('pg_dump'),
          databaseUrl,
          schema,
        }),
        log: (message) => console.error(message),
      });

      await backups.start('manual');
      await backups.idle();

      const status = await backups.status();
      expect(status.backups[0]).toMatchObject({ status: 'completed' });
      const [file] = await readdir(directory);
      await admin.query(`CREATE DATABASE "${restored}"`);
      const [program, ...prefix] = postgresTool('pg_restore');
      const restore = spawnSync(
        program!,
        [...prefix, '--no-owner', `--dbname=${restored}`],
        {
          encoding: 'utf8',
          env: { ...process.env, ...connection(databaseUrl, restored) },
          input: await readFile(join(directory, file!)),
        },
      );
      expect(restore.stderr).toBe('');
      expect(restore.status).toBe(0);

      const copy = new Pool({
        connectionString: Object.assign(new URL(databaseUrl), {
          pathname: `/${restored}`,
        }).toString(),
      });
      try {
        const { rows } = await copy.query<{ id: string; name: string }>(
          `SELECT id, name FROM "${schema}".projects`,
        );
        expect(rows).toEqual([{ id: projectId, name: 'website' }]);
      } finally {
        await copy.end();
      }
    });
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS "${restored}"`);
    await admin.end();
    await rm(directory, { force: true, recursive: true });
  }
}, 180_000);
