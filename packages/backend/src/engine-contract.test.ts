import { randomUUID } from 'node:crypto';

import { afterEach, beforeAll, describe, expect, test } from 'vitest';

import {
  agentContainerName,
  ContainerNotFoundError,
  EngineError,
  InvalidContainerSpecError,
  type AgentContainerSpec,
  type ContainerEngine,
} from './engine.js';
import { createFakeEngine } from './fake-engine.js';

interface EngineHarness {
  readonly engine: ContainerEngine;
  spec(runId: string): AgentContainerSpec;
  /** Makes whatever the run's container needs before it can be created. */
  prepare(runId: string): Promise<void>;
  /** Removes whatever a test left behind, however it failed. */
  cleanup(runIds: readonly string[]): Promise<void>;
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
    });

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

    test('a container is found by its run name', async () => {
      const { engine } = subject;
      const runId = await newRun();
      const { id } = await engine.create(subject.spec(runId));

      expect((await engine.inspect(agentContainerName(runId)))?.id).toBe(id);
    });

    test('an unknown container is absent, and commands on it are refused as not found', async () => {
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
    });

    test(
      'a running container is not removed',
      async () => {
        const { engine } = subject;
        const runId = await newRun();
        const { id } = await engine.create(subject.spec(runId));
        await engine.start(id);

        const refusal = await engine.remove(id).catch((error: unknown) => error);

        expect(refusal).toBeInstanceOf(EngineError);
        expect(refusal).not.toBeInstanceOf(ContainerNotFoundError);
        expect((await engine.inspect(id))?.status).toBe('running');
      },
      options.timeout,
    );

    test('a run has one container', async () => {
      const { engine } = subject;
      const runId = await newRun();
      await engine.create(subject.spec(runId));

      const refusal = await engine
        .create(subject.spec(runId))
        .catch((error: unknown) => error);

      expect(refusal).toBeInstanceOf(EngineError);
      expect(refusal).not.toBeInstanceOf(ContainerNotFoundError);
    });

    test('an invalid specification creates nothing', async () => {
      const { engine } = subject;
      const runId = await newRun();

      await expect(
        engine.create({
          ...subject.spec(runId),
          resources: { cpus: 0, memoryBytes: 1 },
        }),
      ).rejects.toBeInstanceOf(InvalidContainerSpecError);
      expect(await engine.inspect(agentContainerName(runId))).toBeNull();
    });
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
}));

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
