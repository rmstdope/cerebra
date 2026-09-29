// @vitest-environment node
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';

import { cloneMirror } from './project-registration.js';

const git = promisify(execFile);
const credential = 'synthetic-github-token';
const authorization = `Basic ${Buffer.from(`x-access-token:${credential}`).toString('base64')}`;
const files = new Map<string, Buffer>();
const requests: Array<string | undefined> = [];
let directory: string;
let remote: string;
let commit: string;

const server = createServer((request, response) => {
  requests.push(request.headers.authorization);
  if (request.headers.authorization !== authorization) {
    response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="GitHub"' });
    response.end();
    return;
  }
  const path = new URL(request.url ?? '/', 'http://localhost').pathname;
  const body = files.get(path);
  response.writeHead(body === undefined ? 404 : 200);
  response.end(body);
});

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'cerebra-private-mirror-'));
  const source = join(directory, 'source');
  const bare = join(directory, 'private.git');
  await git('git', ['init', '--initial-branch=main', source]);
  await writeFile(join(source, 'README.md'), 'Private fixture\n');
  await git('git', ['-C', source, 'add', 'README.md']);
  await git('git', [
    '-C',
    source,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-m',
    'Fixture',
  ]);
  commit = (
    await git('git', ['-C', source, 'rev-parse', 'HEAD'])
  ).stdout.trim();
  await git('git', ['clone', '--bare', source, bare]);
  await git('git', ['--git-dir', bare, 'update-server-info']);
  for (const entry of await readdir(bare, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (entry.isFile()) {
      const path = join(entry.parentPath, entry.name);
      files.set(
        `/private.git/${path.slice(bare.length + 1)}`,
        await readFile(path),
      );
    }
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Expected a TCP address.');
  }
  remote = `http://127.0.0.1:${address.port}/private.git`;
});

afterAll(async () => {
  try {
    if (server.listening) {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  } finally {
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test('clones a private Git HTTP mirror using token Basic authentication without persisting credentials', async () => {
  requests.length = 0;
  const destination = join(directory, 'mirror.git');
  await cloneMirror(remote, destination, credential);

  expect(requests.length).toBeGreaterThan(0);
  expect(requests.every((header) => header === authorization)).toBe(true);
  expect(
    (
      await git('git', ['--git-dir', destination, 'rev-parse', 'HEAD'])
    ).stdout.trim(),
  ).toBe(commit);
  expect(
    (
      await git('git', [
        '--git-dir',
        destination,
        'rev-parse',
        '--is-bare-repository',
      ])
    ).stdout.trim(),
  ).toBe('true');
  const config = await readFile(join(destination, 'config'), 'utf8');
  expect(config).toContain(remote);
  expect(config).not.toContain(credential);
  expect(config).not.toContain(authorization);
  expect(config).not.toContain('extraheader');
});

test('reports a rejected Git credential without returning it in the error', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    await expect(
      cloneMirror(
        remote,
        join(directory, 'rejected.git'),
        'rejected-synthetic-token',
      ),
    ).rejects.toThrow(/token|access/i);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.mock.calls)).toMatch(
      /Authentication failed|could not read Username/,
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain(
      'rejected-synthetic-token',
    );
  } finally {
    log.mockRestore();
  }
});

test('logs and explains local destination failures', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const destination = join(directory, 'not-a-directory');
  await writeFile(destination, 'occupied');
  try {
    await expect(cloneMirror(remote, destination, credential)).rejects.toThrow(
      /already exists/,
    );
    expect(JSON.stringify(log.mock.calls)).toContain('already exists');
  } finally {
    log.mockRestore();
  }
});

test('logs a missing Git executable with installation guidance', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.stubEnv('PATH', directory);
  try {
    await expect(
      cloneMirror(remote, join(directory, 'missing.git'), credential),
    ).rejects.toThrow(/Git is not installed/);
    expect(JSON.stringify(log.mock.calls)).toContain('ENOENT');
  } finally {
    vi.unstubAllEnvs();
    log.mockRestore();
  }
});

test.each(['split-secret', 'oversized', 'signal', 'empty'] as const)(
  'handles %s Git diagnostics safely',
  async (scenario) => {
    const bin = join(directory, scenario);
    await mkdir(bin);
    const scripts = {
      'split-secret': `
        const encoded = process.env.GIT_CONFIG_VALUE_0.split(' ').at(-1);
        const token = Buffer.from(encoded, 'base64').toString().slice('x-access-token:'.length);
        process.stderr.write('remote: failure ' + token.slice(0, 8));
        setTimeout(() => {
          process.stderr.write(token.slice(8) + '\\nAuthorization: Basic ' + encoded);
          process.exit(128);
        }, 20);
      `,
      oversized: `
        const encoded = process.env.GIT_CONFIG_VALUE_0.split(' ').at(-1);
        process.stderr.write('x'.repeat(65530) + encoded + '\\n', () => process.exit(128));
      `,
      signal: `process.kill(process.pid, 'SIGTERM');`,
      empty: `process.exit(128);`,
    };
    const executable = join(bin, 'git');
    await writeFile(executable, `#!${process.execPath}\n${scripts[scenario]}`);
    await chmod(executable, 0o700);
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubEnv('PATH', bin);
    try {
      await expect(
        cloneMirror(remote, join(directory, `${scenario}.git`), credential),
      ).rejects.toThrow(/Git/);
      expect(log).toHaveBeenCalledTimes(1);
      const output = JSON.stringify(log.mock.calls);
      expect(output).not.toContain(credential);
      expect(output).not.toContain(authorization.split(' ')[1]);
      if (scenario === 'split-secret') expect(output).toContain('[redacted]');
      if (scenario === 'oversized') {
        expect(output).toContain('capture limit');
        expect(output.length).toBeLessThan(2000);
      }
      if (scenario === 'signal') expect(output).toContain('SIGTERM');
      if (scenario === 'empty') expect(output).toContain('128');
    } finally {
      vi.unstubAllEnvs();
      log.mockRestore();
    }
  },
);
