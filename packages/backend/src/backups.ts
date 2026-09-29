import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { open, rename, rm, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Writable } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import type { Kysely } from 'kysely';

import type { Database } from './database.js';

/** How the install configured backups (architecture §10, *Backups*); not editable in the UI. */
export interface BackupConfig {
  /** Where the backend writes dumps: the mounted folder, as the main container sees it. */
  readonly directory: string;
  readonly keep: number;
  /** The folder as the navigator knows it, on the host. */
  readonly location: string;
  /** The daily time, in the backend's local time zone. */
  readonly time: BackupTime;
}

export interface BackupTime {
  readonly hour: number;
  readonly minute: number;
}

export class BackupConfigError extends Error {}

/** Writes one custom-format dump of the database to `output`, and ends it. */
export type Dump = (output: Writable) => Promise<void>;

export type BackupTrigger = 'scheduled' | 'manual';

export interface BackupRecord {
  /** When a completed backup finished, or when a failed attempt started. */
  readonly at: Date;
  readonly cause: string | null;
  readonly id: string;
  readonly sizeBytes: number | null;
  readonly status: 'completed' | 'failed';
}

export interface BackupStatus {
  /** Kept backups and recent failed attempts, newest first. */
  readonly backups: readonly BackupRecord[];
  readonly kept: number;
  readonly running: { readonly startedAt: Date } | null;
  readonly schedule: {
    readonly keep: number;
    readonly location: string;
    readonly nextAt: Date;
  };
}

export type StartResult =
  | { readonly started: true }
  | { readonly reason: 'already_running'; readonly started: false };

export interface Backups {
  /** Marks attempts a restart interrupted as failed and removes what they left. */
  recover(): Promise<void>;
  start(trigger: BackupTrigger): Promise<StartResult>;
  status(): Promise<BackupStatus>;
  /** Starts the scheduled backup when its slot has passed with no attempt since. */
  tick(): Promise<void>;
  /** Resolves when every backup this process started has finished. */
  idle(): Promise<void>;
}

const defaultTime: BackupTime = { hour: 2, minute: 0 };
const defaultKeep = 7;

export function parseBackupConfig(
  environment: NodeJS.ProcessEnv,
): BackupConfig | undefined {
  const directory = environment.CEREBRA_BACKUP_DIR;
  if (directory === undefined || directory === '') return undefined;

  const timeText = environment.CEREBRA_BACKUP_TIME || undefined;
  const time = timeText === undefined ? defaultTime : parseTime(timeText);
  const keepText = environment.CEREBRA_BACKUP_KEEP || undefined;
  if (keepText !== undefined && !/^[1-9]\d{0,3}$/.test(keepText)) {
    throw new BackupConfigError(
      `CEREBRA_BACKUP_KEEP must be a whole number of backups from 1 to 9999, not “${keepText}”.`,
    );
  }
  return {
    directory,
    keep: keepText === undefined ? defaultKeep : Number(keepText),
    location: environment.CEREBRA_BACKUP_LOCATION || directory,
    time,
  };
}

function parseTime(text: string): BackupTime {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(text);
  if (match === null) {
    throw new BackupConfigError(
      `CEREBRA_BACKUP_TIME must be a 24-hour time such as 02:00, not “${text}”.`,
    );
  }
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

/** The first scheduled time strictly after `after`. */
export function nextSlot(time: BackupTime, after: Date): Date {
  const slot = new Date(after);
  slot.setHours(time.hour, time.minute, 0, 0);
  if (slot <= after) slot.setDate(slot.getDate() + 1);
  return slot;
}

/** The last scheduled time at or before `at`. */
export function latestSlot(time: BackupTime, at: Date): Date {
  const slot = new Date(at);
  slot.setHours(time.hour, time.minute, 0, 0);
  if (slot > at) slot.setDate(slot.getDate() - 1);
  return slot;
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/** Why an attempt failed, in words the navigator can act on. */
export function failureCause(error: unknown): string {
  const code = errorCode(error);
  const syscall = (error as { syscall?: unknown } | null)?.syscall;
  if (
    code === 'ENOENT' &&
    typeof syscall === 'string' &&
    syscall.startsWith('spawn')
  ) {
    return 'the backup tool isn’t installed';
  }
  switch (code) {
    case 'ENOSPC':
    case 'EDQUOT':
      return 'the backup folder is full';
    case 'EACCES':
    case 'EPERM':
    case 'EROFS':
      return 'Cerebra can’t write to the backup folder';
    case 'ENOENT':
    case 'ENOTDIR':
      return 'the backup folder isn’t available';
    default:
      return 'the database copy didn’t complete';
  }
}

const restartedCause = 'Cerebra restarted before the backup finished';

export class DumpError extends Error {}

/**
 * Runs `pg_dump` (or a command ending in it) against `databaseUrl`. The connection goes in the
 * environment, never the arguments, so the password is not in the process list or a log.
 */
export function createPgDump({
  command,
  databaseUrl,
  schema,
}: {
  readonly command: readonly string[];
  readonly databaseUrl: string;
  readonly schema?: string;
}): Dump {
  const url = new URL(databaseUrl);
  const connection = {
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    PGHOST: url.hostname,
    PGPASSWORD: decodeURIComponent(url.password),
    PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username),
  };
  const [program, ...prefix] = command;
  if (program === undefined) throw new Error('A dump command is required.');
  return async (output) => {
    const child = spawn(
      program,
      [
        ...prefix,
        '--format=custom',
        '--no-owner',
        ...(schema === undefined ? [] : [`--schema=${schema}`]),
      ],
      {
        env: { ...process.env, ...connection },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 4000) stderr += chunk;
    });
    const exited = new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolve(code ?? 1));
    });
    const [piped, exit] = await Promise.allSettled([
      pipeline(child.stdout, output),
      exited,
    ]);
    if (exit.status === 'rejected') throw exit.reason;
    if (piped.status === 'rejected') throw piped.reason;
    if (exit.value !== 0) {
      throw new DumpError(
        `pg_dump exited with ${exit.value}: ${stderr.trim() || 'no message'}`,
      );
    }
  };
}

function stamp(at: Date): string {
  return at
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
}

function partialName(fileName: string): string {
  return `.${fileName}.partial`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createBackups({
  config,
  database,
  dump,
  log,
  now = () => new Date(),
}: {
  readonly config: BackupConfig;
  readonly database: Kysely<Database>;
  readonly dump: Dump;
  readonly log: (message: string) => void;
  readonly now?: () => Date;
}): Backups {
  const inFlight = new Set<Promise<void>>();

  const fail = async (id: string, cause: string) => {
    await database
      .updateTable('backups')
      .set({ cause, finished_at: now(), status: 'failed' })
      .where('id', '=', id)
      .where('status', '=', 'running')
      .execute();
  };

  const prune = async () => {
    const completed = await database
      .selectFrom('backups')
      .select(['id', 'file_name', 'started_at'])
      .where('status', '=', 'completed')
      .orderBy('started_at', 'desc')
      .orderBy('id', 'desc')
      .execute();
    for (const row of completed.slice(config.keep)) {
      try {
        await unlink(join(config.directory, row.file_name ?? ''));
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') {
          log(
            `Backup ${row.file_name} is past the retention count but could not be removed: ${describeError(error)}`,
          );
          continue;
        }
      }
      await database.deleteFrom('backups').where('id', '=', row.id).execute();
    }
    const oldestKept = completed.slice(0, config.keep).at(-1);
    if (oldestKept !== undefined) {
      await database
        .deleteFrom('backups')
        .where('status', '=', 'failed')
        .where('started_at', '<', oldestKept.started_at)
        .execute();
    }
    const failures = await database
      .selectFrom('backups')
      .select('id')
      .where('status', '=', 'failed')
      .orderBy('started_at', 'desc')
      .orderBy('id', 'desc')
      .offset(config.keep)
      .limit(1_000_000)
      .execute();
    if (failures.length > 0) {
      await database
        .deleteFrom('backups')
        .where(
          'id',
          'in',
          failures.map((row) => row.id),
        )
        .execute();
    }
  };

  const run = async (id: string, fileName: string) => {
    const partial = join(config.directory, partialName(fileName));
    try {
      const stream = createWriteStream(partial, { flags: 'wx' });
      // A dump that gives up mid-write leaves writes to fail after the file is gone.
      stream.on('error', () => {});
      try {
        await dump(stream);
        await finished(stream);
      } finally {
        stream.destroy();
      }
      const written = await open(partial, 'r+');
      try {
        await written.sync();
      } finally {
        await written.close();
      }
      const target = join(config.directory, fileName);
      await rename(partial, target);
      const { size } = await stat(target);
      await database
        .updateTable('backups')
        .set({
          finished_at: now(),
          size_bytes: String(size),
          status: 'completed',
        })
        .where('id', '=', id)
        .execute();
    } catch (error) {
      log(`Backup ${fileName} failed: ${describeError(error)}`);
      await rm(partial, { force: true }).catch(() => {});
      await fail(id, failureCause(error));
    }
    try {
      await prune();
    } catch (error) {
      log(`Removing old backups failed: ${describeError(error)}`);
    }
  };

  const start = async (trigger: BackupTrigger): Promise<StartResult> => {
    const startedAt = now();
    let id: string;
    try {
      ({ id } = await database
        .insertInto('backups')
        .values({ started_at: startedAt, status: 'running', trigger })
        .returning('id')
        .executeTakeFirstOrThrow());
    } catch (error) {
      if (errorCode(error) === '23505') {
        return { reason: 'already_running', started: false };
      }
      throw error;
    }
    const fileName = `cerebra-${stamp(startedAt)}-${id}.dump`;
    await database
      .updateTable('backups')
      .set({ file_name: fileName })
      .where('id', '=', id)
      .execute();
    const work = run(id, fileName).catch((error: unknown) =>
      log(`Backup ${fileName} could not be recorded: ${describeError(error)}`),
    );
    inFlight.add(work);
    void work.finally(() => inFlight.delete(work));
    return { started: true };
  };

  return {
    async idle() {
      while (inFlight.size > 0) await Promise.all([...inFlight]);
    },

    async recover() {
      const interrupted = await database
        .selectFrom('backups')
        .select(['id', 'file_name'])
        .where('status', '=', 'running')
        .execute();
      for (const row of interrupted) {
        if (row.file_name !== null) {
          await rm(join(config.directory, partialName(row.file_name)), {
            force: true,
          }).catch((error: unknown) =>
            log(
              `Could not remove an interrupted backup's partial file: ${describeError(error)}`,
            ),
          );
        }
        await fail(row.id, restartedCause);
      }
    },

    start,

    async status() {
      const rows = await database
        .selectFrom('backups')
        .select([
          'id',
          'status',
          'started_at',
          'finished_at',
          'size_bytes',
          'cause',
        ])
        .orderBy('started_at', 'desc')
        .orderBy('id', 'desc')
        .execute();
      const running = rows.find((row) => row.status === 'running');
      const backups = rows.flatMap((row): BackupRecord[] =>
        row.status === 'running'
          ? []
          : [
              {
                at:
                  row.status === 'completed'
                    ? (row.finished_at ?? row.started_at)
                    : row.started_at,
                cause: row.cause,
                id: row.id,
                sizeBytes:
                  row.size_bytes === null ? null : Number(row.size_bytes),
                status: row.status,
              },
            ],
      );
      return {
        backups,
        kept: backups.filter((backup) => backup.status === 'completed').length,
        running:
          running === undefined ? null : { startedAt: running.started_at },
        schedule: {
          keep: config.keep,
          location: config.location,
          nextAt: nextSlot(config.time, now()),
        },
      };
    },

    async tick() {
      const slot = latestSlot(config.time, now());
      const { scheduled_since } = await database
        .selectFrom('backup_schedule')
        .select('scheduled_since')
        .executeTakeFirstOrThrow();
      if (slot < scheduled_since) return;
      const attempt = await database
        .selectFrom('backups')
        .select('id')
        .where('started_at', '>=', slot)
        .limit(1)
        .executeTakeFirst();
      if (attempt !== undefined) return;
      await start('scheduled');
    },
  };
}
