import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const image = 'postgres:18';
const databaseName = 'cerebra_test';
const databaseUser = 'cerebra_test';
const readinessAttempts = 30;
const readinessDelayMilliseconds = 500;

function run(command, arguments_, options = {}) {
  return spawnSync(command, arguments_, {
    encoding: 'utf8',
    ...options,
  });
}

function commandError(result) {
  if (result.error?.code === 'ENOENT') {
    return 'Podman is required to provision a disposable PostgreSQL test database. Install and start Podman, or set DATABASE_URL to a reachable disposable database.';
  }

  return 'Unable to provision a disposable PostgreSQL test database with Podman. Set DATABASE_URL to a reachable disposable database or correct the Podman failure.';
}

function runPodman(arguments_) {
  return run('podman', arguments_, { stdio: ['ignore', 'pipe', 'pipe'] });
}

function databasePort(portOutput) {
  const address = portOutput.trim().split('\n')[0] ?? '';
  const match = /^(?:127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d+)$/.exec(address);

  if (!match) {
    throw new Error(
      'Podman did not report a loopback port for the disposable PostgreSQL test database.',
    );
  }

  return match[1];
}

async function waitForDatabase(containerName) {
  for (let attempt = 0; attempt < readinessAttempts; attempt += 1) {
    const result = runPodman([
      'exec',
      containerName,
      'pg_isready',
      '--username',
      databaseUser,
      '--dbname',
      databaseName,
    ]);

    if (result.status === 0) {
      return;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, readinessDelayMilliseconds);
    });
  }

  throw new Error(
    'The disposable PostgreSQL test database did not become ready in time.',
  );
}

function runTestCommand(command, arguments_, databaseUrl) {
  const result = run(command, arguments_, {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'inherit',
  });

  if (result.error) {
    throw result.error;
  }

  return result.status ?? 1;
}

async function withDisposableDatabase(command, arguments_) {
  const containerName = `cerebra-test-${process.pid}-${randomUUID().replaceAll('-', '')}`;
  const password = randomUUID();
  let started = false;

  try {
    const start = runPodman([
      'run',
      '--detach',
      '--rm',
      '--name',
      containerName,
      '--publish',
      '127.0.0.1::5432',
      '--env',
      `POSTGRES_DB=${databaseName}`,
      '--env',
      `POSTGRES_PASSWORD=${password}`,
      '--env',
      `POSTGRES_USER=${databaseUser}`,
      image,
    ]);

    if (start.status !== 0) {
      throw new Error(commandError(start));
    }

    started = true;
    const port = runPodman(['port', containerName, '5432/tcp']);

    if (port.status !== 0) {
      throw new Error(commandError(port));
    }

    await waitForDatabase(containerName);
    const databaseUrl = `postgresql://${databaseUser}:${encodeURIComponent(password)}@127.0.0.1:${databasePort(port.stdout)}/${databaseName}`;

    return runTestCommand(command, arguments_, databaseUrl);
  } finally {
    if (started) {
      runPodman(['rm', '--force', containerName]);
    }
  }
}

async function main() {
  const [command, ...arguments_] = process.argv.slice(2);

  if (!command) {
    throw new Error('A test command is required.');
  }

  const exitCode = process.env.DATABASE_URL
    ? runTestCommand(command, arguments_, process.env.DATABASE_URL)
    : await withDisposableDatabase(command, arguments_);

  process.exitCode = exitCode;
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
