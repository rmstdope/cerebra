import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Writable } from 'node:stream';
import { sql, type Kysely } from 'kysely';
import { afterEach, describe, expect, test } from 'vitest';

import {
  BackupConfigError,
  createBackups,
  failureCause,
  latestSlot,
  nextSlot,
  parseBackupConfig,
  type BackupConfig,
  type Dump,
} from './backups.js';
import type { Database } from './database.js';
import { withTestDatabase } from './test-support.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function folder(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'cerebra-backups-'));
  directories.push(directory);
  return directory;
}

function config(directory: string, keep = 7): BackupConfig {
  return {
    directory,
    keep,
    location: '/Users/navigator/cerebra-backups',
    time: { hour: 2, minute: 0 },
  };
}

function writes(content: string): Dump {
  return async (output: Writable) => {
    await new Promise<void>((resolve, reject) =>
      output.end(content, (error?: Error | null) =>
        error ? reject(error) : resolve(),
      ),
    );
  };
}

function failsWith(code: string): Dump {
  return async (output) => {
    output.write('partial');
    throw Object.assign(new Error(code), { code });
  };
}

/** A dump that waits until released, so a test can look at a running backup. */
function held(): { dump: Dump; release: () => void } {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    dump: async (output) => {
      output.write('begun');
      await gate;
      await new Promise<void>((resolve) => output.end('done', resolve));
    },
    release: () => release(),
  };
}

const quiet = () => {};

async function setScheduledSince(
  database: Kysely<Database>,
  at: Date,
): Promise<void> {
  await database
    .updateTable('backup_schedule')
    .set({ scheduled_since: at })
    .execute();
}

describe('a backup', () => {
  test('is renamed into place when complete and recorded with its size', async () => {
    await withTestDatabase(async (database) => {
      const directory = await folder();
      const at = new Date(2026, 8, 29, 14, 2, 0);
      const backups = createBackups({
        config: config(directory),
        database,
        dump: writes('custom-format-dump'),
        log: quiet,
        now: () => at,
      });

      expect(await backups.start('manual')).toEqual({ started: true });
      await backups.idle();

      const files = await readdir(directory);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/^cerebra-\d{8}T\d{6}Z-\d+\.dump$/);
      expect(await readFile(join(directory, files[0]!), 'utf8')).toBe(
        'custom-format-dump',
      );
      const status = await backups.status();
      expect(status.running).toBeNull();
      expect(status.kept).toBe(1);
      expect(status.backups).toEqual([
        {
          at,
          cause: null,
          id: expect.any(String),
          sizeBytes: 18,
          status: 'completed',
        },
      ]);
    });
  });

  test.each([
    ['ENOSPC', 'the backup folder is full'],
    ['EACCES', 'Cerebra can’t write to the backup folder'],
    ['EIO', 'the database copy didn’t complete'],
  ])(
    'that fails with %s leaves no file and records why in plain words',
    async (code, cause) => {
      await withTestDatabase(async (database) => {
        const directory = await folder();
        const at = new Date(2026, 8, 29, 2, 0, 0);
        const backups = createBackups({
          config: config(directory),
          database,
          dump: failsWith(code),
          log: quiet,
          now: () => at,
        });

        await backups.start('scheduled');
        await backups.idle();

        expect(await readdir(directory)).toEqual([]);
        const status = await backups.status();
        expect(status.kept).toBe(0);
        expect(status.backups).toEqual([
          {
            at,
            cause,
            id: expect.any(String),
            sizeBytes: null,
            status: 'failed',
          },
        ]);
      });
    },
  );

  test('that fails before the file is even open leaves no file', async () => {
    await withTestDatabase(async (database) => {
      const directory = await folder();
      const backups = createBackups({
        config: config(directory),
        database,
        dump: async () => {
          throw Object.assign(new Error('EIO'), { code: 'EIO' });
        },
        log: quiet,
      });

      for (let attempt = 0; attempt < 20; attempt += 1) {
        await backups.start('manual');
        await backups.idle();
      }

      expect(await readdir(directory)).toEqual([]);
    });
  });

  test('that cannot be recorded as completed leaves no file behind', async () => {
    await withTestDatabase(async (database) => {
      await sql`
        CREATE FUNCTION refuse_completion() RETURNS trigger AS $$
        BEGIN
          RAISE EXCEPTION 'refused';
        END $$ LANGUAGE plpgsql
      `.execute(database);
      await sql`
        CREATE TRIGGER refuse_completion BEFORE UPDATE ON backups
        FOR EACH ROW WHEN (NEW.status = 'completed')
        EXECUTE FUNCTION refuse_completion()
      `.execute(database);
      const directory = await folder();
      const backups = createBackups({
        config: config(directory),
        database,
        dump: writes('dump'),
        log: quiet,
      });

      await backups.start('manual');
      await backups.idle();

      expect(await readdir(directory)).toEqual([]);
      expect((await backups.status()).backups).toMatchObject([
        { status: 'failed' },
      ]);
    });
  });

  test('names its file from the moment it starts', async () => {
    await withTestDatabase(async (database) => {
      const directory = await folder();
      const { dump, release } = held();
      const backups = createBackups({
        config: config(directory),
        database,
        dump,
        log: quiet,
      });

      await backups.start('manual');
      const running = await database
        .selectFrom('backups')
        .select(['id', 'file_name'])
        .executeTakeFirstOrThrow();
      release();
      await backups.idle();

      expect(running.file_name).toMatch(
        new RegExp(`^cerebra-\\d{8}T\\d{6}Z-${running.id}\\.dump$`),
      );
    });
  });

  test('to a folder that is not there fails as unavailable', async () => {
    await withTestDatabase(async (database) => {
      const directory = join(await folder(), 'unmounted');
      const backups = createBackups({
        config: config(directory),
        database,
        dump: writes('dump'),
        log: quiet,
      });

      await backups.start('manual');
      await backups.idle();

      expect((await backups.status()).backups[0]).toMatchObject({
        cause: 'the backup folder isn’t available',
        status: 'failed',
      });
    });
  });

  test('is refused while another is running, and shows as running', async () => {
    await withTestDatabase(async (database) => {
      const directory = await folder();
      const at = new Date(2026, 8, 29, 14, 2, 0);
      const { dump, release } = held();
      const backups = createBackups({
        config: config(directory),
        database,
        dump,
        log: quiet,
        now: () => at,
      });

      expect(await backups.start('manual')).toEqual({ started: true });
      expect(await backups.start('manual')).toEqual({
        reason: 'already_running',
        started: false,
      });
      // A second backend process is refused by the database, not only by this one.
      expect(
        await createBackups({
          config: config(directory),
          database,
          dump,
          log: quiet,
        }).start('scheduled'),
      ).toEqual({ reason: 'already_running', started: false });
      const running = await backups.status();
      expect(running.running).toEqual({ startedAt: at });
      expect(running.backups).toEqual([]);

      release();
      await backups.idle();
      expect((await backups.status()).running).toBeNull();
    });
  });
});

describe('retention', () => {
  test('keeps the newest completed backups and never touches files it did not make', async () => {
    await withTestDatabase(async (database) => {
      const directory = await folder();
      await writeFile(join(directory, 'navigator-notes.txt'), 'mine');
      let clock = new Date(2026, 8, 20, 2, 0, 0);
      const backups = createBackups({
        config: config(directory, 3),
        database,
        dump: writes('dump'),
        log: quiet,
        now: () => clock,
      });

      for (let day = 0; day < 5; day += 1) {
        clock = new Date(2026, 8, 20 + day, 2, 0, 0);
        await backups.start('scheduled');
        await backups.idle();
      }

      const status = await backups.status();
      expect(status.kept).toBe(3);
      expect(status.backups.map((backup) => backup.at)).toEqual([
        new Date(2026, 8, 24, 2, 0, 0),
        new Date(2026, 8, 23, 2, 0, 0),
        new Date(2026, 8, 22, 2, 0, 0),
      ]);
      const files = await readdir(directory);
      expect(files.filter((file) => file.endsWith('.dump'))).toHaveLength(3);
      expect(files).toContain('navigator-notes.txt');
    });
  });

  test('lists failures since the oldest kept backup, at most as many as are kept', async () => {
    await withTestDatabase(async (database) => {
      const directory = await folder();
      let clock = new Date(2026, 8, 20, 2, 0, 0);
      let dump: Dump = failsWith('ENOSPC');
      const backups = createBackups({
        config: config(directory, 2),
        database,
        dump: (output) => dump(output),
        log: quiet,
        now: () => clock,
      });
      const attempt = async (day: number, next: Dump) => {
        clock = new Date(2026, 8, day, 2, 0, 0);
        dump = next;
        await backups.start('scheduled');
        await backups.idle();
      };

      await attempt(20, failsWith('ENOSPC'));
      await attempt(21, writes('dump'));
      await attempt(22, writes('dump'));
      await attempt(23, failsWith('ENOSPC'));
      await attempt(24, failsWith('ENOSPC'));
      await attempt(25, failsWith('ENOSPC'));

      const status = await backups.status();
      expect(status.kept).toBe(2);
      expect(
        status.backups.map((backup) => [backup.at.getDate(), backup.status]),
      ).toEqual([
        [25, 'failed'],
        [24, 'failed'],
        [22, 'completed'],
        [21, 'completed'],
      ]);
    });
  });

  test('keeps the record of a backup whose file could not be removed', async () => {
    await withTestDatabase(async (database) => {
      const directory = await folder();
      let clock = new Date(2026, 8, 20, 2, 0, 0);
      const logged: string[] = [];
      const backups = createBackups({
        config: config(directory, 1),
        database,
        dump: writes('dump'),
        log: (message) => logged.push(message),
        now: () => clock,
      });
      await backups.start('scheduled');
      await backups.idle();
      const [first] = await readdir(directory);
      // A directory in its place cannot be unlinked.
      await rm(join(directory, first!));
      await mkdir(join(directory, first!));
      await writeFile(join(directory, first!, 'x'), 'x');

      clock = new Date(2026, 8, 21, 2, 0, 0);
      await backups.start('scheduled');
      await backups.idle();

      expect((await backups.status()).kept).toBe(2);
      expect(logged.join('\n')).toContain(first!);
    });
  });
});

describe('the schedule', () => {
  const two = { hour: 2, minute: 0 };

  test.each([
    [new Date(2026, 8, 29, 1, 59), new Date(2026, 8, 29, 2, 0)],
    [new Date(2026, 8, 29, 2, 0), new Date(2026, 8, 30, 2, 0)],
    [new Date(2026, 8, 30, 23, 0), new Date(2026, 9, 1, 2, 0)],
  ])('after %s the next backup is %s', (after, next) => {
    expect(nextSlot(two, after)).toEqual(next);
  });

  test.each([
    [new Date(2026, 8, 29, 1, 59), new Date(2026, 8, 28, 2, 0)],
    [new Date(2026, 8, 29, 2, 0), new Date(2026, 8, 29, 2, 0)],
    [new Date(2026, 8, 29, 14, 0), new Date(2026, 8, 29, 2, 0)],
  ])('at %s the latest slot is %s', (at, slot) => {
    expect(latestSlot(two, at)).toEqual(slot);
  });

  test('starts a missed slot once, and not again after it failed', async () => {
    await withTestDatabase(async (database) => {
      const directory = await folder();
      await setScheduledSince(database, new Date(2026, 8, 28, 12, 0));
      let clock = new Date(2026, 8, 29, 1, 0);
      let dump: Dump = failsWith('ENOSPC');
      const backups = createBackups({
        config: config(directory),
        database,
        dump: (output) => dump(output),
        log: quiet,
        now: () => clock,
      });

      await backups.tick();
      await backups.idle();
      expect((await backups.status()).backups).toEqual([]);

      // Asleep at 02:00; caught up on waking at 07:30.
      clock = new Date(2026, 8, 29, 7, 30);
      await backups.tick();
      await backups.idle();
      clock = new Date(2026, 8, 29, 7, 31);
      dump = writes('dump');
      await backups.tick();
      await backups.idle();
      const status = await backups.status();
      expect(status.backups).toEqual([
        expect.objectContaining({
          at: new Date(2026, 8, 29, 7, 30),
          status: 'failed',
        }),
      ]);
      expect(status.schedule).toEqual({
        keep: 7,
        location: '/Users/navigator/cerebra-backups',
        nextAt: new Date(2026, 8, 30, 2, 0),
      });

      clock = new Date(2026, 8, 30, 2, 0);
      await backups.tick();
      await backups.idle();
      expect((await backups.status()).backups[0]).toMatchObject({
        status: 'completed',
      });
    });
  });

  test('does not count slots from before the schedule existed', async () => {
    await withTestDatabase(async (database) => {
      const directory = await folder();
      await setScheduledSince(database, new Date(2026, 8, 29, 14, 0));
      const backups = createBackups({
        config: config(directory),
        database,
        dump: writes('dump'),
        log: quiet,
        now: () => new Date(2026, 8, 29, 14, 5),
      });

      await backups.tick();
      await backups.idle();

      expect((await backups.status()).backups).toEqual([]);
    });
  });

  test('a manual backup after the slot stands in for it', async () => {
    await withTestDatabase(async (database) => {
      const directory = await folder();
      await setScheduledSince(database, new Date(2026, 8, 28, 12, 0));
      let clock = new Date(2026, 8, 29, 3, 0);
      const backups = createBackups({
        config: config(directory),
        database,
        dump: writes('dump'),
        log: quiet,
        now: () => clock,
      });
      await backups.start('manual');
      await backups.idle();
      clock = new Date(2026, 8, 29, 3, 1);
      await backups.tick();
      await backups.idle();

      expect((await backups.status()).backups).toHaveLength(1);
    });
  });
});

describe('after a restart', () => {
  test('a backup left running is failed and its partial file removed', async () => {
    await withTestDatabase(async (database) => {
      const directory = await folder();
      const { dump } = held();
      const at = new Date(2026, 8, 29, 2, 0);
      const before = createBackups({
        config: config(directory),
        database,
        dump,
        log: quiet,
        now: () => at,
      });
      await before.start('scheduled');
      await expect.poll(async () => (await readdir(directory)).length).toBe(1);

      const after = createBackups({
        config: config(directory),
        database,
        dump: writes('dump'),
        log: quiet,
        now: () => new Date(2026, 8, 29, 9, 0),
      });
      await after.recover();

      expect(await readdir(directory)).toEqual([]);
      const status = await after.status();
      expect(status.running).toBeNull();
      expect(status.backups).toEqual([
        expect.objectContaining({
          at,
          cause: 'Cerebra restarted before the backup finished',
          status: 'failed',
        }),
      ]);
    });
  });
});

describe('failure causes', () => {
  test.each([
    [{ code: 'ENOSPC' }, 'the backup folder is full'],
    [{ code: 'EDQUOT' }, 'the backup folder is full'],
    [{ code: 'EROFS' }, 'Cerebra can’t write to the backup folder'],
    [{ code: 'EPERM' }, 'Cerebra can’t write to the backup folder'],
    [{ code: 'ENOTDIR' }, 'the backup folder isn’t available'],
    [
      { code: 'ENOENT', syscall: 'spawn pg_dump' },
      'the backup tool isn’t installed',
    ],
    [new Error('boom'), 'the database copy didn’t complete'],
    ['nothing', 'the database copy didn’t complete'],
  ])('%j reads as “%s”', (error, cause) => {
    expect(
      failureCause(
        error instanceof Error || typeof error !== 'object'
          ? error
          : Object.assign(new Error('x'), error),
      ),
    ).toBe(cause);
  });
});

describe('the install settings', () => {
  test('are absent without a backup folder', () => {
    expect(parseBackupConfig({})).toBeUndefined();
  });

  test('default to 02:00 and seven backups, shown at the folder itself', () => {
    expect(parseBackupConfig({ CEREBRA_BACKUP_DIR: '/backups' })).toEqual({
      directory: '/backups',
      keep: 7,
      location: '/backups',
      time: { hour: 2, minute: 0 },
    });
  });

  test('read the time, the count and the mounted location', () => {
    expect(
      parseBackupConfig({
        CEREBRA_BACKUP_DIR: '/backups',
        CEREBRA_BACKUP_KEEP: '14',
        CEREBRA_BACKUP_LOCATION: '/Users/navigator/backups',
        CEREBRA_BACKUP_TIME: '23:45',
      }),
    ).toEqual({
      directory: '/backups',
      keep: 14,
      location: '/Users/navigator/backups',
      time: { hour: 23, minute: 45 },
    });
  });

  test.each([
    { CEREBRA_BACKUP_TIME: '2am' },
    { CEREBRA_BACKUP_TIME: '24:00' },
    { CEREBRA_BACKUP_TIME: '02:60' },
    { CEREBRA_BACKUP_KEEP: '0' },
    { CEREBRA_BACKUP_KEEP: 'seven' },
    { CEREBRA_BACKUP_KEEP: '1.5' },
  ])('refuse %j', (environment) => {
    expect(() =>
      parseBackupConfig({ CEREBRA_BACKUP_DIR: '/backups', ...environment }),
    ).toThrow(BackupConfigError);
  });
});
