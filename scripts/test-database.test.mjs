import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';

const wrapper = resolve(process.cwd(), 'scripts/test-database.mjs');
const workspaces = [];

async function createWorkspace() {
  const workspace = await mkdtemp(join(tmpdir(), 'cerebra-test-database-'));
  workspaces.push(workspace);
  const podman = join(workspace, 'podman');

  await writeFile(
    podman,
    `#!${process.execPath}
import { appendFileSync } from 'node:fs';

appendFileSync(process.env.PODMAN_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');

switch (process.argv[2]) {
  case 'run':
    process.exit(Number(process.env.PODMAN_RUN_EXIT ?? 0));
  case 'port':
    process.stdout.write('127.0.0.1:54321\\n');
    break;
  case 'exec':
    process.exit(Number(process.env.PODMAN_READY_EXIT ?? 0));
  case 'rm':
    process.exit(Number(process.env.PODMAN_REMOVE_EXIT ?? 0));
    break;
  default:
    process.exit(0);
}
`,
    { mode: 0o755 },
  );

  return {
    childDatabaseUrl: join(workspace, 'child-database-url'),
    log: join(workspace, 'podman-log'),
    podman,
    workspace,
  };
}

function runWrapper(
  { childDatabaseUrl, log, workspace },
  { childExit = 0, databaseUrl, includePodman = true } = {},
) {
  const environment = {
    ...process.env,
    CHILD_DATABASE_URL: childDatabaseUrl,
    CHILD_EXIT: String(childExit),
    PATH: includePodman
      ? `${workspace}:${process.env.PATH}`
      : join(workspace, 'without-podman'),
    PODMAN_LOG: log,
  };

  if (databaseUrl) {
    environment.DATABASE_URL = databaseUrl;
  } else {
    delete environment.DATABASE_URL;
  }

  return spawnSync(
    process.execPath,
    [
      wrapper,
      process.execPath,
      '-e',
      "require('node:fs').writeFileSync(process.env.CHILD_DATABASE_URL, process.env.DATABASE_URL ?? ''); process.exit(Number(process.env.CHILD_EXIT));",
    ],
    {
      encoding: 'utf8',
      env: environment,
    },
  );
}

async function podmanCommands(log) {
  try {
    return (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }

    throw error;
  }
}

afterEach(async () => {
  await Promise.all(
    workspaces.splice(0).map((workspace) => rm(workspace, { recursive: true })),
  );
});

describe('test database wrapper', () => {
  test('uses an explicitly supplied database without provisioning or cleanup', async () => {
    const fixture = await createWorkspace();
    const databaseUrl =
      'postgresql://provided:password@localhost:5432/provided';

    const result = runWrapper(fixture, { databaseUrl });

    expect(result.status).toBe(0);
    expect(await readFile(fixture.childDatabaseUrl, 'utf8')).toBe(databaseUrl);
    expect(await podmanCommands(fixture.log)).toEqual([]);
  });

  test('provisions and removes its own ready database when none is supplied', async () => {
    const fixture = await createWorkspace();

    const result = runWrapper(fixture);
    const commands = await podmanCommands(fixture.log);

    expect(result.status).toBe(0);
    expect(await readFile(fixture.childDatabaseUrl, 'utf8')).toMatch(
      /^postgresql:\/\/cerebra_test:.+@127\.0\.0\.1:54321\/cerebra_test$/,
    );
    expect(commands.map(([command]) => command)).toEqual([
      'run',
      'port',
      'exec',
      'rm',
    ]);
    expect(commands[0]).toContain('postgres:18');
    expect(commands[3]).toEqual(['rm', '--force', expect.any(String)]);
  });

  test('removes its own database when the test command fails', async () => {
    const fixture = await createWorkspace();

    const result = runWrapper(fixture, { childExit: 2 });

    expect(result.status).toBe(2);
    expect(
      (await podmanCommands(fixture.log)).map(([command]) => command),
    ).toEqual(['run', 'port', 'exec', 'rm']);
  });

  test('reports an actionable error when Podman is unavailable', async () => {
    const fixture = await createWorkspace();

    const result = runWrapper(fixture, { includePodman: false });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'Podman is required to provision a disposable PostgreSQL test database.',
    );
    expect(result.stderr).not.toContain('DATABASE_URL=');
  });
});
