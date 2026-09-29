// @vitest-environment node
import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  CheckoutError,
  createRunCheckouts,
  projectGitAccess,
  type ProjectGitAccess,
  type RunCheckouts,
} from './checkouts.js';
import { cloneMirror } from './project-registration.js';
import {
  registerTestProject,
  testMasterKey,
  withTestDatabase,
} from './test-support.js';

const exec = promisify(execFile);
const credential = 'synthetic-checkout-token';

let root: string;
let source: string;
let github: string;
let data: string;
let projectId: string;
let access: ProjectGitAccess;
let checkouts: RunCheckouts;

async function git(...args: string[]): Promise<string> {
  return (await exec('git', args)).stdout.trim();
}

async function commit(file: string, text: string): Promise<string> {
  await writeFile(join(source, file), text);
  await git('-C', source, 'add', file);
  await git(
    '-C',
    source,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    file,
  );
  return git('-C', source, 'rev-parse', 'HEAD');
}

const mirrorOf = (id: string) => join(data, 'projects', id, 'mirror.git');
const checkoutOf = (runId: string) => join(data, 'runs', runId, 'checkout');

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cerebra-checkouts-'));
  source = join(root, 'source');
  github = join(root, 'github', 'website.git');
  data = join(root, 'data');
  await git('init', '-q', '--initial-branch=main', source);
  await commit('README.md', 'main\n');
  await git('-C', source, 'checkout', '-qb', 'feature');
  await commit('feature.txt', 'feature\n');
  await git('-C', source, 'checkout', '-q', 'main');
  await git('clone', '-q', '--bare', source, github);
  await git('-C', source, 'remote', 'add', 'origin', github);
  projectId = crypto.randomUUID();
  access = { credential, defaultBranch: 'main', remote: github };
  await mkdir(join(data, 'projects', projectId), { recursive: true });
  await cloneMirror(github, mirrorOf(projectId), credential);
  checkouts = createRunCheckouts({
    dataDirectory: data,
    project: async (id) => {
      if (id !== projectId) throw new Error(`unknown project ${id}`);
      return access;
    },
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { force: true, recursive: true });
});

describe('a run checkout', () => {
  test('is a clone of the default branch whose origin is GitHub, not the mirror', async () => {
    const runId = crypto.randomUUID();
    await checkouts.create({ projectId, runId });

    const checkout = checkoutOf(runId);
    expect(await git('-C', checkout, 'branch', '--show-current')).toBe('main');
    expect(await git('-C', checkout, 'rev-parse', 'HEAD')).toBe(
      await git('-C', source, 'rev-parse', 'main'),
    );
    expect(await git('-C', checkout, 'config', 'remote.origin.url')).toBe(
      github,
    );
    expect(await git('-C', checkout, 'config', '--list')).not.toContain(
      mirrorOf(projectId),
    );
    expect(
      await exists(join(checkout, '.git', 'objects', 'info', 'alternates')),
    ).toBe(false);
  });

  test('shares no file with the mirror', async () => {
    const runId = crypto.randomUUID();
    await checkouts.create({ projectId, runId });

    const objects = join(checkoutOf(runId), '.git', 'objects');
    const files = (
      await readdir(objects, { recursive: true, withFileTypes: true })
    )
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect((await stat(file)).nlink).toBe(1);
    }
  });

  test('carries what was pushed to GitHub since the mirror was last fetched', async () => {
    const pushed = await commit('later.txt', 'later\n');
    await git('-C', source, 'push', '-q', 'origin', 'main');
    const runId = crypto.randomUUID();
    await checkouts.create({ projectId, runId });

    expect(await git('-C', checkoutOf(runId), 'rev-parse', 'HEAD')).toBe(
      pushed,
    );
  });

  test('can start from another branch, as rework does', async () => {
    const runId = crypto.randomUUID();
    await checkouts.create({ base: 'feature', projectId, runId });

    expect(await git('-C', checkoutOf(runId), 'branch', '--show-current')).toBe(
      'feature',
    );
    expect(await exists(join(checkoutOf(runId), 'feature.txt'))).toBe(true);
  });

  test('rebuilds a missing mirror before cloning', async () => {
    await rm(join(data, 'projects', projectId), {
      force: true,
      recursive: true,
    });
    const runId = crypto.randomUUID();
    await checkouts.create({ projectId, runId });

    expect(await exists(mirrorOf(projectId))).toBe(true);
    expect(await git('-C', checkoutOf(runId), 'branch', '--show-current')).toBe(
      'main',
    );
  });

  test('is made for two runs of one project at once', async () => {
    const [first, second] = [crypto.randomUUID(), crypto.randomUUID()];
    await Promise.all([
      checkouts.create({ projectId, runId: first }),
      checkouts.create({ projectId, runId: second }),
    ]);
    expect(await exists(join(checkoutOf(first), 'README.md'))).toBe(true);
    expect(await exists(join(checkoutOf(second), 'README.md'))).toBe(true);
  });
});

describe('a checkout that cannot be made', () => {
  test('names a branch that is not on GitHub and leaves nothing behind', async () => {
    const runId = crypto.randomUUID();
    await expect(
      checkouts.create({ base: 'missing', projectId, runId }),
    ).rejects.toThrow(
      new CheckoutError('The branch missing is not on GitHub.'),
    );
    expect(await exists(join(data, 'runs', runId))).toBe(false);
  });

  test('says the fetch failed, without the credential, and leaves nothing behind', async () => {
    const hidden = join(root, credential, 'gone.git');
    await mkdir(join(root, credential));
    await git('clone', '-q', '--bare', source, hidden);
    await rm(join(data, 'projects', projectId), {
      force: true,
      recursive: true,
    });
    await mkdir(join(data, 'projects', projectId), { recursive: true });
    await cloneMirror(hidden, mirrorOf(projectId), credential);
    await rm(hidden, { force: true, recursive: true });
    access = { ...access, remote: hidden };
    const runId = crypto.randomUUID();

    const error = await checkouts
      .create({ projectId, runId })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CheckoutError);
    expect((error as Error).message).toMatch(
      /^Cerebra could not fetch the latest code from GitHub: /,
    );
    expect((error as Error).message).not.toContain(credential);
    expect(await exists(join(data, 'runs', runId))).toBe(false);
  });

  test('says the clone failed when the checkout cannot be written', async () => {
    const runId = crypto.randomUUID();
    await mkdir(join(data, 'runs', runId, 'checkout'), { recursive: true });
    await writeFile(join(data, 'runs', runId, 'checkout', 'occupied'), 'x');

    await expect(checkouts.create({ projectId, runId })).rejects.toThrow(
      /^Cerebra could not make the run’s checkout: /,
    );
  });

  test('refuses an id that is not a run id before touching anything', async () => {
    await expect(
      checkouts.create({ projectId, runId: '../projects' }),
    ).rejects.toThrow(new CheckoutError('../projects is not a run id.'));
    await expect(checkouts.remove('../projects')).rejects.toThrow(
      new CheckoutError('../projects is not a run id.'),
    );
    expect(await exists(mirrorOf(projectId))).toBe(true);
  });
});

describe('cleaning up', () => {
  test('removes one run’s directory and nothing of another run', async () => {
    const [ended, other] = [crypto.randomUUID(), crypto.randomUUID()];
    await checkouts.create({ projectId, runId: ended });
    await checkouts.create({ projectId, runId: other });
    // An agent can plant a link to anything; removal must not follow it.
    await symlink(checkoutOf(other), join(checkoutOf(ended), 'other'));

    await checkouts.remove(ended);

    expect(await exists(join(data, 'runs', ended))).toBe(false);
    expect(await exists(join(checkoutOf(other), 'README.md'))).toBe(true);
    expect(await exists(mirrorOf(projectId))).toBe(true);
  });

  test('succeeds for a run that has no directory', async () => {
    await expect(
      checkouts.remove(crypto.randomUUID()),
    ).resolves.toBeUndefined();
  });

  test('sweeps every run directory that is not live, and nothing else', async () => {
    const [gone, live] = [crypto.randomUUID(), crypto.randomUUID()];
    await checkouts.create({ projectId, runId: gone });
    await checkouts.create({ projectId, runId: live });
    await mkdir(join(data, 'runs', 'notes'));

    await checkouts.sweep(new Set([live]));

    expect(await exists(join(data, 'runs', gone))).toBe(false);
    expect(await exists(join(checkoutOf(live), 'README.md'))).toBe(true);
    expect(await exists(join(data, 'runs', 'notes'))).toBe(true);
  });

  test('sweeps nothing when no run directory was ever made', async () => {
    await expect(checkouts.sweep(new Set())).resolves.toBeUndefined();
  });
});

describe('a project’s git access', () => {
  test('is its remote, default branch and decrypted GitHub token', async () => {
    await withTestDatabase(async (database) => {
      const projectId = await registerTestProject(database);
      await expect(
        projectGitAccess(database, testMasterKey)(projectId),
      ).resolves.toEqual({
        credential: 'token',
        defaultBranch: 'main',
        remote: 'https://github.com/acme/website.git',
      });
    });
  });

  test('says so when there is no such project', async () => {
    await withTestDatabase(async (database) => {
      const missing = crypto.randomUUID();
      await expect(
        projectGitAccess(database, testMasterKey)(missing),
      ).rejects.toThrow(new CheckoutError(`There is no project ${missing}.`));
    });
  });

  test('says the token cannot be read under another master key', async () => {
    await withTestDatabase(async (database) => {
      const projectId = await registerTestProject(database);
      await expect(
        projectGitAccess(
          database,
          Buffer.alloc(32, 9).toString('base64'),
        )(projectId),
      ).rejects.toThrow(/GitHub token cannot be decrypted/);
    });
  });
});
