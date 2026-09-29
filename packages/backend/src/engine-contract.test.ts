import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';

import {
  agentContainerName,
  ContainerNotFoundError,
  EngineError,
  InvalidContainerSpecError,
  type AgentContainerSpec,
  type ContainerEngine,
} from './engine.js';
import { createFakeEngine } from './fake-engine.js';
import { createPodmanEngine } from './podman-engine.js';

interface EngineHarness {
  readonly engine: ContainerEngine;
  spec(runId: string): AgentContainerSpec;
  /** Makes whatever the run's container needs before it can be created. */
  prepare(runId: string): Promise<void>;
  /** Removes whatever a test left behind, however it failed. */
  cleanup(runIds: readonly string[]): Promise<void>;
  /** Removes whatever the harness made. */
  teardown(): Promise<void>;
}

function engineContract(
  name: string,
  harness: () => EngineHarness,
  options: { readonly skip?: boolean; readonly timeout?: number } = {},
): void {
  describe.skipIf(options.skip ?? false)(`${name} engine contract`, () => {
    let subject: EngineHarness;
    let runIds: string[] = [];

    beforeAll(() => {
      subject = harness();
    }, options.timeout);

    afterAll(async () => {
      await subject?.teardown();
    }, options.timeout);

    afterEach(async () => {
      await subject.cleanup(runIds);
      runIds = [];
    }, options.timeout);

    async function newRun(): Promise<string> {
      const runId = `run-${randomUUID().slice(0, 8)}`;
      runIds.push(runId);
      await subject.prepare(runId);
      return runId;
    }

    test(
      'a created container is inspected, started, stopped and removed',
      async () => {
        const { engine } = subject;
        const runId = await newRun();
        const { id } = await engine.create(subject.spec(runId));

        expect(await engine.inspect(id)).toMatchObject({
          agentId: 'agent-1',
          exitCode: null,
          id,
          name: agentContainerName(runId),
          runId,
          status: 'created',
        });

        await engine.start(id);
        expect(await engine.inspect(id)).toMatchObject({
          exitCode: null,
          status: 'running',
        });

        await engine.stop(id, { timeoutSeconds: 1 });
        const stopped = await engine.inspect(id);
        expect(stopped?.status).toBe('exited');
        expect(typeof stopped?.exitCode).toBe('number');

        await engine.stop(id, { timeoutSeconds: 1 });
        await engine.remove(id);
        expect(await engine.inspect(id)).toBeNull();
      },
      options.timeout,
    );

    test(
      'a container is found by its run name',
      { timeout: options.timeout },
      async () => {
        const { engine } = subject;
        const runId = await newRun();
        const { id } = await engine.create(subject.spec(runId));

        expect((await engine.inspect(agentContainerName(runId)))?.id).toBe(id);
      },
    );

    test(
      'an unknown container is absent, and commands on it are refused as not found',
      { timeout: options.timeout },
      async () => {
        const { engine } = subject;
        const missing = `cerebra-run-missing-${randomUUID().slice(0, 8)}`;

        expect(await engine.inspect(missing)).toBeNull();
        await expect(engine.start(missing)).rejects.toBeInstanceOf(
          ContainerNotFoundError,
        );
        await expect(engine.stop(missing)).rejects.toBeInstanceOf(
          ContainerNotFoundError,
        );
        await expect(engine.remove(missing)).rejects.toBeInstanceOf(
          ContainerNotFoundError,
        );
      },
    );

    test(
      'a running container is not removed',
      async () => {
        const { engine } = subject;
        const runId = await newRun();
        const { id } = await engine.create(subject.spec(runId));
        await engine.start(id);

        const refusal = await engine
          .remove(id)
          .catch((error: unknown) => error);

        expect(refusal).toBeInstanceOf(EngineError);
        expect(refusal).not.toBeInstanceOf(ContainerNotFoundError);
        expect((await engine.inspect(id))?.status).toBe('running');
      },
      options.timeout,
    );

    test('a run has one container', { timeout: options.timeout }, async () => {
      const { engine } = subject;
      const runId = await newRun();
      await engine.create(subject.spec(runId));

      const refusal = await engine
        .create(subject.spec(runId))
        .catch((error: unknown) => error);

      expect(refusal).toBeInstanceOf(EngineError);
      expect(refusal).not.toBeInstanceOf(ContainerNotFoundError);
    });

    test(
      'an invalid specification creates nothing',
      { timeout: options.timeout },
      async () => {
        const { engine } = subject;
        const runId = await newRun();

        await expect(
          engine.create({
            ...subject.spec(runId),
            resources: { cpus: 0, memoryBytes: 1 },
          }),
        ).rejects.toBeInstanceOf(InvalidContainerSpecError);
        expect(await engine.inspect(agentContainerName(runId))).toBeNull();
      },
    );
  });
}

const fakeSettings = {
  dataVolume: 'cerebra-data',
  egressNetwork: 'cerebro-egress',
  internalNetwork: 'cerebro-internal',
};

function fakeSpec(runId: string): AgentContainerSpec {
  return {
    agentId: 'agent-1',
    environment: {},
    image: 'localhost/cerebro-agent:latest',
    resources: { cpus: 1, memoryBytes: 256 * 1024 ** 2 },
    runId,
  };
}

engineContract('fake', () => ({
  cleanup: async () => undefined,
  engine: createFakeEngine(fakeSettings),
  prepare: async () => undefined,
  spec: fakeSpec,
  teardown: async () => undefined,
}));

// Real rootless Podman is opt-in until roadmap step 7 brings it to CI. The podman CLI
// must reach the same engine as the socket (on macOS, the machine's API socket).
const podmanSocket = process.env.CEREBRA_TEST_PODMAN_SOCKET ?? '';
const podmanImage =
  process.env.CEREBRA_TEST_PODMAN_IMAGE ?? 'docker.io/library/alpine:3';
const podmanTimeout = 120_000;

function podman(...arguments_: string[]): string {
  const result = spawnSync('podman', arguments_, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(
      `podman ${arguments_[0]} failed: ${result.error?.message ?? result.stderr}`,
    );
  }
  return result.stdout;
}

function podmanHarness(): EngineHarness {
  const suffix = randomUUID().slice(0, 8);
  const settings = {
    dataVolume: `cerebra-test-data-${suffix}`,
    egressNetwork: `cerebra-test-egress-${suffix}`,
    internalNetwork: `cerebra-test-internal-${suffix}`,
  };
  podman('pull', '--quiet', podmanImage);
  podman('network', 'create', '--internal', settings.internalNetwork);
  podman('network', 'create', settings.egressNetwork);
  podman('volume', 'create', settings.dataVolume);

  return {
    cleanup: async (runIds) => {
      for (const runId of runIds) {
        spawnSync('podman', [
          'rm',
          '--force',
          '--time',
          '0',
          agentContainerName(runId),
        ]);
      }
    },
    engine: createPodmanEngine({ ...settings, socketPath: podmanSocket }),
    prepare: async (runId) => {
      const directories = [
        `/data/runs/${runId}/checkout`,
        '/data/agents/agent-1/home',
        '/data/agents/agent-1/cli-state',
      ];
      podman(
        'run',
        '--rm',
        '--volume',
        `${settings.dataVolume}:/data`,
        podmanImage,
        'sh',
        '-c',
        `mkdir -p ${directories.join(' ')} && chown -R 1000:1000 /data/runs /data/agents`,
      );
    },
    spec: (runId) => ({
      ...fakeSpec(runId),
      command: ['sleep', '300'],
      image: podmanImage,
    }),
    teardown: async () => {
      spawnSync('podman', ['volume', 'rm', '--force', settings.dataVolume]);
      spawnSync('podman', [
        'network',
        'rm',
        '--force',
        settings.internalNetwork,
        settings.egressNetwork,
      ]);
    },
  };
}

engineContract('rootless Podman', podmanHarness, {
  skip: podmanSocket === '',
  timeout: podmanTimeout,
});

describe.skipIf(podmanSocket === '')(
  'a rootless Podman agent container',
  () => {
    let harness: EngineHarness;
    const runId = `run-${randomUUID().slice(0, 8)}`;

    beforeAll(() => {
      harness = podmanHarness();
    }, podmanTimeout);

    afterAll(async () => {
      await harness?.cleanup([runId]);
      await harness?.teardown();
    }, podmanTimeout);

    test(
      'runs unprivileged, read-only, and without the engine socket',
      async () => {
        await harness.prepare(runId);
        const { id } = await harness.engine.create({
          ...harness.spec(runId),
          environment: { CEREBRA_PROBE: 'present' },
        });
        await harness.engine.start(id);

        const probe = podman(
          'exec',
          id,
          'sh',
          '-c',
          [
            'echo "uid=$(id -u)"',
            'grep -E "^(CapEff|NoNewPrivs):" /proc/self/status | tr -d "\\t"',
            'touch /probe 2>/dev/null && echo root=writable || echo root=read-only',
            'touch /work/probe && echo work=writable',
            'touch /tmp/probe && echo tmp=writable',
            'echo "probe=$CEREBRA_PROBE"',
            'for s in /run/podman/podman.sock /var/run/docker.sock /run/docker.sock; do [ -e "$s" ] && echo "socket=$s"; done; true',
          ].join('; '),
        );

        expect(probe.trim().split('\n')).toEqual([
          'uid=1000',
          'CapEff:0000000000000000',
          'NoNewPrivs:1',
          'root=read-only',
          'work=writable',
          'tmp=writable',
          'probe=present',
        ]);
      },
      podmanTimeout,
    );
  },
);

describe('the fake engine', () => {
  test('records the request the real engine would receive', async () => {
    const engine = createFakeEngine(fakeSettings);
    const { id } = await engine.create(fakeSpec('run-1'));

    expect(engine.requestFor(id)?.body.HostConfig.ReadonlyRootfs).toBe(true);
    expect(engine.requestFor(id)?.name).toBe('cerebra-run-run-1');
    expect(engine.requestFor('unknown')).toBeUndefined();
  });

  test('fails the next call of an operation with the given error, once', async () => {
    const engine = createFakeEngine(fakeSettings);
    const failure = new EngineError('inspect', 'The engine is down.');
    const { id } = await engine.create(fakeSpec('run-1'));

    engine.failNext('inspect', failure);

    await expect(engine.inspect(id)).rejects.toBe(failure);
    expect((await engine.inspect(id))?.status).toBe('created');
  });
});
