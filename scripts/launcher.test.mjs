import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, expect, test } from 'vitest';

const launcher = resolve('cerebra');
const workspaces = [];

async function fixture() {
  const directory = resolve(`.launcher-test-${randomUUID()}`);
  workspaces.push(directory);
  await mkdir(directory);
  await writeFile(join(directory, '.env'), '');
  await writeFile(
    join(directory, 'podman'),
    `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync('calls', JSON.stringify(args) + '\\n');
if (args[0] === 'secret' && args[1] === 'exists') {
  process.exit(Number(process.env.SECRET_EXISTS_EXIT ?? (existsSync('secret') ? 0 : 1)));
}
if (args[0] === 'secret' && args[1] === 'create') {
  if (process.env.SECRET_CREATE_FAIL) process.exit(125);
  if (existsSync('secret')) process.exit(125);
  writeFileSync('secret', readFileSync(0));
}
if (args.includes('psql')) process.exit(Number(process.env.DATABASE_CHECK_EXIT ?? 0));
if (args.includes('up')) process.exit(Number(process.env.COMPOSE_UP_EXIT ?? 0));
if (args.includes('node')) process.exit(Number(process.env.MAIN_READY_EXIT ?? 0));
`,
    { mode: 0o755 },
  );
  await writeFile(
    join(directory, 'openssl'),
    `#!${process.execPath}
if (process.env.GENERATOR_FAIL) process.exit(1);
process.stdout.write(Buffer.alloc(32, 19).toString('base64') + '\\n');
`,
    { mode: 0o755 },
  );
  await writeFile(join(directory, 'sleep'), '#!/bin/sh\nexit 0\n', {
    mode: 0o755,
  });
  return directory;
}

function launch(directory, command = 'start', environment = {}) {
  return spawnSync('/bin/bash', [launcher, command], {
    cwd: directory,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      ...environment,
    },
  });
}

async function calls(directory) {
  return (await readFile(join(directory, 'calls'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

afterEach(async () => {
  await Promise.all(
    workspaces
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test('bootstraps once, keeps the key across starts and updates, and never prints it', async () => {
  const directory = await fixture();
  const first = launch(directory);
  expect(first.status).toBe(0);
  const key = await readFile(join(directory, 'secret'), 'utf8');
  expect(Buffer.from(key, 'base64')).toHaveLength(32);
  for (const command of ['start', 'update']) {
    const result = launch(directory, command);
    expect(result.status).toBe(0);
    expect(result.stdout + result.stderr).not.toContain(key);
    expect(await readFile(join(directory, 'secret'), 'utf8')).toBe(key);
  }
  expect(first.stdout + first.stderr).not.toContain(key);
  const commands = await calls(directory);
  expect(
    commands.filter((args) => args[0] === 'secret' && args[1] === 'create'),
  ).toHaveLength(1);
  expect(commands.filter((args) => args.includes('psql'))).toHaveLength(1);
  expect(commands.find((args) => args.includes('up'))).toEqual([
    'compose',
    '--file',
    'images/podman-compose.yml',
    'up',
    '--detach',
    '--no-recreate',
    'postgres',
  ]);
});

test.each([
  [{ SECRET_EXISTS_EXIT: '125' }, 'inspect'],
  [{ DATABASE_CHECK_EXIT: '1' }, 'existing'],
  [{ GENERATOR_FAIL: '1' }, 'generate'],
  [{ SECRET_CREATE_FAIL: '1' }, 'store'],
])(
  'does not start main when key provisioning fails: %j',
  async (environment, message) => {
    const directory = await fixture();
    const result = launch(directory, 'start', environment);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(message);
    expect(
      (await calls(directory)).some((args) => args.includes('--build')),
    ).toBe(false);
  },
);

test('a failed compose launch preserves the provisioned key', async () => {
  const directory = await fixture();
  expect(launch(directory).status).toBe(0);
  const key = await readFile(join(directory, 'secret'), 'utf8');
  const result = launch(directory, 'update', { COMPOSE_UP_EXIT: '1' });
  expect(result.status).not.toBe(0);
  expect(result.stdout).not.toContain('ready at');
  expect(await readFile(join(directory, 'secret'), 'utf8')).toBe(key);
});

test('status reports a missing secret without provisioning or starting anything', async () => {
  const directory = await fixture();
  const result = launch(directory, 'status');
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('secret');
  expect(
    (await calls(directory)).some(
      (args) => args.includes('create') || args.includes('up'),
    ),
  ).toBe(false);
});

test('status checks health without changing a provisioned instance', async () => {
  const directory = await fixture();
  await writeFile(join(directory, 'secret'), 'existing-test-secret');
  expect(launch(directory, 'status').status).toBe(0);
  expect(
    (await calls(directory)).some(
      (args) => args.includes('create') || args.includes('up'),
    ),
  ).toBe(false);
});

test('never reports ready when the backend fails to start', async () => {
  const directory = await fixture();
  await writeFile(join(directory, 'secret'), 'existing-test-secret');
  const result = launch(directory, 'start', { MAIN_READY_EXIT: '1' });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('did not become healthy');
  expect(result.stdout).not.toContain('ready at');
  expect(await readFile(join(directory, 'secret'), 'utf8')).toBe(
    'existing-test-secret',
  );
}, 20_000);
