import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { platform } from 'node:os';

// The real-Podman suites (architecture §13): builds the agent and stub images, then runs the
// end-to-end loop and the engine contract against the rootless Podman API socket. They fail,
// rather than skip, when Podman is missing.
const suites = [
  'packages/backend/src/e2e.test.ts',
  'packages/backend/src/engine-contract.test.ts',
];

function run(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {
    encoding: 'utf8',
    stdio: 'inherit',
    ...options,
  });
  if (result.error?.code === 'ENOENT') {
    throw new Error(
      `${command} is required to run the real-Podman tests. Install it, or run pnpm run check without them.`,
    );
  }
  if (result.error) {
    throw result.error;
  }
  return result;
}

function output(command, arguments_) {
  const result = run(command, arguments_, {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return result.status === 0 ? result.stdout.trim() : '';
}

/** The rootless Podman API socket: named, or the Podman machine's on macOS, or the user's. */
function podmanSocket() {
  const named = process.env.CEREBRA_TEST_PODMAN_SOCKET;
  if (named) {
    return named;
  }
  if (platform() === 'darwin') {
    return output('podman', [
      'machine',
      'inspect',
      '--format',
      '{{.ConnectionInfo.PodmanSocket.Path}}',
    ]);
  }
  return output('podman', ['info', '--format', '{{.Host.RemoteSocket.Path}}']);
}

function build(tag, containerfile) {
  const result = run('podman', [
    'build',
    '--tag',
    tag,
    '--file',
    containerfile,
    '.',
  ]);
  if (result.status !== 0) {
    throw new Error(`Could not build ${tag} from ${containerfile}.`);
  }
}

try {
  const socket = podmanSocket();
  if (socket === '' || !existsSync(socket)) {
    throw new Error(
      `No rootless Podman API socket at "${socket}". Start one (podman system service --time=0, or systemctl --user start podman.socket) or name it in CEREBRA_TEST_PODMAN_SOCKET.`,
    );
  }
  // CEREBRA_E2E_IMAGE names a stub image built some other way, and skips the builds.
  if (!process.env.CEREBRA_E2E_IMAGE) {
    build('cerebro-agent', 'images/agent.Containerfile');
    build('cerebra-stub-agent', 'images/stub-agent.Containerfile');
  }
  // The suites import the workspace's packages from their built output.
  if (run('pnpm', ['run', 'build']).status !== 0) {
    throw new Error('Could not build the workspace.');
  }
  const result = run(
    'node',
    ['scripts/test-database.mjs', 'pnpm', 'exec', 'vitest', 'run', ...suites],
    {
      env: {
        ...process.env,
        CEREBRA_E2E: '1',
        CEREBRA_REQUIRE_PODMAN: '1',
        CEREBRA_TEST_PODMAN_SOCKET: socket,
      },
    },
  );
  process.exitCode = result.status ?? 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
