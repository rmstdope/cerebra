import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

import type { Kysely } from 'kysely';

import type { Database } from './database.js';

const minimumPasswordLength = 8;
const defaultSessionLifetimeMs = 30 * 24 * 60 * 60 * 1_000;
const passwordKeyLength = 64;

export interface AuthOptions {
  readonly now?: () => Date;
  readonly sessionLifetimeMs?: number;
}

export type AuthStatus =
  | { readonly state: 'authenticated' }
  | { readonly state: 'setup' }
  | {
      readonly reason: 'expired' | 'signed-out';
      readonly state: 'unauthenticated';
    };

export type AuthenticationResult =
  | {
      readonly ok: false;
      readonly reason:
        'already-configured' | 'invalid-password' | 'rejected-password';
    }
  | { readonly ok: true; readonly sessionToken: string };

export interface AuthService {
  setup(password: string): Promise<AuthenticationResult>;
  signIn(password: string): Promise<AuthenticationResult>;
  signOut(sessionToken: string | undefined): Promise<void>;
  status(sessionToken: string | undefined): Promise<AuthStatus>;
}

export function createAuthService(
  database: Kysely<Database>,
  {
    now = () => new Date(),
    sessionLifetimeMs = defaultSessionLifetimeMs,
  }: AuthOptions = {},
): AuthService {
  async function createSession(userId: string): Promise<AuthenticationResult> {
    const sessionToken = randomBytes(32).toString('base64url');
    const createdAt = now();

    await database
      .insertInto('sessions')
      .values({
        token_hash: hashToken(sessionToken),
        user_id: userId,
        created_at: createdAt,
        expires_at: new Date(createdAt.getTime() + sessionLifetimeMs),
      })
      .execute();

    return { ok: true, sessionToken };
  }

  return {
    async setup(password) {
      if (!isValidPassword(password)) {
        return { ok: false, reason: 'invalid-password' };
      }

      const userId = crypto.randomUUID();
      const passwordHash = await hashPassword(password);

      try {
        return await database.transaction().execute(async (transaction) => {
          const configured = await transaction
            .selectFrom('authentication_configuration')
            .select('user_id')
            .executeTakeFirst();
          if (configured !== undefined) {
            return { ok: false, reason: 'already-configured' };
          }

          await transaction
            .insertInto('users')
            .values({
              id: userId,
              created_at: now(),
              password_hash: passwordHash,
            })
            .execute();
          await transaction
            .insertInto('authentication_configuration')
            .values({ id: true, user_id: userId })
            .execute();

          const sessionToken = randomBytes(32).toString('base64url');
          const createdAt = now();
          await transaction
            .insertInto('sessions')
            .values({
              token_hash: hashToken(sessionToken),
              user_id: userId,
              created_at: createdAt,
              expires_at: new Date(createdAt.getTime() + sessionLifetimeMs),
            })
            .execute();
          return { ok: true, sessionToken };
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          return { ok: false, reason: 'already-configured' };
        }
        throw error;
      }
    },

    async signIn(password) {
      const user = await database
        .selectFrom('authentication_configuration')
        .innerJoin('users', 'users.id', 'authentication_configuration.user_id')
        .select(['users.id', 'users.password_hash'])
        .executeTakeFirst();
      if (
        user === undefined ||
        !(await passwordMatches(password, user.password_hash))
      ) {
        return { ok: false, reason: 'rejected-password' };
      }

      return createSession(user.id);
    },

    async signOut(sessionToken) {
      if (sessionToken === undefined) {
        return;
      }

      await database
        .deleteFrom('sessions')
        .where('token_hash', '=', hashToken(sessionToken))
        .execute();
    },

    async status(sessionToken) {
      const configured = await database
        .selectFrom('authentication_configuration')
        .select('user_id')
        .executeTakeFirst();
      if (configured === undefined) {
        return { state: 'setup' };
      }
      if (sessionToken === undefined) {
        return { state: 'unauthenticated', reason: 'signed-out' };
      }

      const tokenHash = hashToken(sessionToken);
      const session = await database
        .selectFrom('sessions')
        .select('expires_at')
        .where('token_hash', '=', tokenHash)
        .executeTakeFirst();
      if (session === undefined) {
        return { state: 'unauthenticated', reason: 'signed-out' };
      }
      if (session.expires_at <= now()) {
        await database
          .deleteFrom('sessions')
          .where('token_hash', '=', tokenHash)
          .execute();
        return { state: 'unauthenticated', reason: 'expired' };
      }

      return { state: 'authenticated' };
    },
  };
}

function isValidPassword(password: string): boolean {
  return password.length >= minimumPasswordLength;
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await derivePassword(password, salt);
  return `${salt.toString('base64url')}:${derived.toString('base64url')}`;
}

async function passwordMatches(
  password: string,
  storedHash: string,
): Promise<boolean> {
  const [encodedSalt, encodedHash, extra] = storedHash.split(':');
  if (
    encodedSalt === undefined ||
    encodedHash === undefined ||
    extra !== undefined
  ) {
    return false;
  }

  const salt = Buffer.from(encodedSalt, 'base64url');
  const expected = Buffer.from(encodedHash, 'base64url');
  if (expected.length !== passwordKeyLength) {
    return false;
  }

  return timingSafeEqual(await derivePassword(password, salt), expected);
}

function derivePassword(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, passwordKeyLength, (error, derivedKey) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(derivedKey);
    });
  });
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23505'
  );
}
