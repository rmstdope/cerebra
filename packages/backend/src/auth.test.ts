import { Pool } from 'pg';
import { describe, expect, test } from 'vitest';

import { createAuthService } from './auth.js';
import { createDatabase } from './database.js';
import { migrateToLatest } from './migrations/index.js';

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error('DATABASE_URL is required to run authentication tests');
}

function schemaName(): string {
  return `cerebra_auth_${crypto.randomUUID().replaceAll('-', '')}`;
}

async function createSchema(): Promise<string> {
  const schema = schemaName();
  const pool = new Pool({ connectionString: databaseUrl });

  try {
    await pool.query(`CREATE SCHEMA "${schema}"`);
  } finally {
    await pool.end();
  }

  return schema;
}

async function dropSchema(schema: string): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl });

  try {
    await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
  } finally {
    await pool.end();
  }
}

describe('authentication', { concurrent: false }, () => {
  test('creates the first password and an opaque session', async () => {
    const schema = await createSchema();
    const database = createDatabase(databaseUrl, schema);

    try {
      await migrateToLatest(database, schema);
      const auth = createAuthService(database);

      await expect(auth.setup('short')).resolves.toEqual({
        ok: false,
        reason: 'invalid-password',
      });

      const result = await auth.setup('a password with enough length');

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }

      expect(await auth.status(result.sessionToken)).toEqual({
        state: 'authenticated',
      });
      expect(
        await database
          .selectFrom('users')
          .selectAll()
          .executeTakeFirstOrThrow(),
      ).toMatchObject({
        password_hash: expect.not.stringContaining(
          'a password with enough length',
        ),
      });
      expect(
        await database
          .selectFrom('sessions')
          .selectAll()
          .executeTakeFirstOrThrow(),
      ).toMatchObject({
        token_hash: expect.not.stringContaining(result.sessionToken),
      });
    } finally {
      await database.destroy();
      await dropSchema(schema);
    }
  });

  test('rejects an incorrect password and expires or revokes sessions', async () => {
    const schema = await createSchema();
    const database = createDatabase(databaseUrl, schema);
    let now = new Date('2026-09-28T20:00:00.000Z');

    try {
      await migrateToLatest(database, schema);
      const auth = createAuthService(database, {
        now: () => now,
        sessionLifetimeMs: 1_000,
      });
      const setup = await auth.setup('a password with enough length');

      expect(setup.ok).toBe(true);
      expect(await auth.signIn('wrong password')).toEqual({
        ok: false,
        reason: 'rejected-password',
      });

      const signIn = await auth.signIn('a password with enough length');
      expect(signIn.ok).toBe(true);
      if (!signIn.ok) {
        return;
      }

      await auth.signOut(signIn.sessionToken);
      expect(await auth.status(signIn.sessionToken)).toEqual({
        state: 'unauthenticated',
        reason: 'signed-out',
      });

      now = new Date(now.getTime() + 1_001);
      expect(
        await auth.status(setup.ok ? setup.sessionToken : undefined),
      ).toEqual({
        state: 'unauthenticated',
        reason: 'expired',
      });
    } finally {
      await database.destroy();
      await dropSchema(schema);
    }
  });

  test('allows only one concurrent first-use setup', async () => {
    const schema = await createSchema();
    const database = createDatabase(databaseUrl, schema);

    try {
      await migrateToLatest(database, schema);
      const auth = createAuthService(database);

      const results = await Promise.all([
        auth.setup('first valid password'),
        auth.setup('second valid password'),
      ]);

      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results).toContainEqual({
        ok: false,
        reason: 'already-configured',
      });
      expect(
        await database
          .selectFrom('authentication_configuration')
          .selectAll()
          .execute(),
      ).toHaveLength(1);
      expect(
        await database.selectFrom('users').selectAll().execute(),
      ).toHaveLength(1);
    } finally {
      await database.destroy();
      await dropSchema(schema);
    }
  });
});
