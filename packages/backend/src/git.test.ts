// @vitest-environment node
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, test } from 'vitest';

import { GitCommandError, runGit } from './git.js';

const exec = promisify(execFile);
let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'cerebra-git-'));
});

afterEach(async () => {
  await rm(directory, { force: true, recursive: true });
});

test('runs git and resolves when it succeeds', async () => {
  await runGit(['init', '--bare', join(directory, 'repo.git')]);
  const { stdout } = await exec('git', [
    '--git-dir',
    join(directory, 'repo.git'),
    'rev-parse',
    '--is-bare-repository',
  ]);
  expect(stdout.trim()).toBe('true');
});

test('kills git that outlives its time bound and says so', async () => {
  // A fetch from a pipe that never answers stands in for a hung network.
  const repo = join(directory, 'repo.git');
  await exec('git', ['init', '--bare', repo]);
  await exec('git', [
    '--git-dir',
    repo,
    'config',
    'remote.origin.url',
    'ext::sleep 30',
  ]);
  const started = Date.now();
  await expect(
    runGit(
      [
        '-c',
        'protocol.ext.allow=always',
        '--git-dir',
        repo,
        'fetch',
        'origin',
      ],
      { timeoutMs: 300 },
    ),
  ).rejects.toThrow('Git did not finish within 1 second and was stopped.');
  expect(Date.now() - started).toBeLessThan(10_000);
});

test('does not read the global or system git config', async () => {
  const home = join(directory, 'home');
  await exec('mkdir', ['-p', home]);
  await writeFile(
    join(home, '.gitconfig'),
    '[alias]\n\tcerebra-probe = !touch probe-ran\n',
  );
  const previous = process.env.HOME;
  process.env.HOME = home;
  try {
    await expect(runGit(['-C', directory, 'cerebra-probe'])).rejects.toThrow(
      GitCommandError,
    );
  } finally {
    process.env.HOME = previous;
  }
});

test('redacts the credential from what it reports', async () => {
  const credential = 'synthetic-secret-token';
  const error = await runGit(
    ['ls-remote', `http://127.0.0.1:1/${credential}.git`],
    { credential },
  ).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(GitCommandError);
  expect((error as Error).message).not.toContain(credential);
  expect((error as GitCommandError).diagnostic).not.toContain(credential);
});
