import { randomBytes } from 'node:crypto';

import {
  agentContainerRequest,
  ContainerNotFoundError,
  EngineError,
  type AgentContainerRequest,
  type AgentContainerSpec,
  type ContainerEngine,
  type ContainerInfo,
  type ContainerStatus,
  type EngineOperation,
  type EngineSettings,
  requireAgentId,
  stopTimeoutSeconds,
} from './engine.js';

export interface FakeEngine extends ContainerEngine {
  /** The create request the real engine would have received for this container. */
  requestFor(idOrName: string): AgentContainerRequest | undefined;
  /** The next call of `operation` throws `error` instead of running. */
  failNext(operation: EngineOperation, error: Error): void;
}

interface FakeContainer {
  readonly id: string;
  readonly request: AgentContainerRequest;
  readonly runId: string;
  readonly agentId: string;
  status: ContainerStatus;
  exitCode: number | null;
}

const defaultSettings: EngineSettings = {
  dataVolume: 'cerebra-data',
  egressNetwork: 'cerebro-egress',
  internalNetwork: 'cerebro-internal',
};

/** An in-memory engine that refuses and fails as the Podman engine does. */
export function createFakeEngine(
  settings: EngineSettings = defaultSettings,
): FakeEngine {
  const containers = new Map<string, FakeContainer>();
  const failures = new Map<EngineOperation, Error>();

  function injected(operation: EngineOperation): void {
    const failure = failures.get(operation);
    if (failure !== undefined) {
      failures.delete(operation);
      throw failure;
    }
  }

  function find(idOrName: string): FakeContainer | undefined {
    return (
      containers.get(idOrName) ??
      [...containers.values()].find(
        (container) => container.request.name === idOrName,
      )
    );
  }

  function existing(operation: EngineOperation, id: string): FakeContainer {
    const container = find(id);
    if (container === undefined) {
      throw new ContainerNotFoundError(operation, id);
    }
    return container;
  }

  return {
    async create(spec: AgentContainerSpec) {
      injected('create');
      const request = agentContainerRequest(spec, settings);
      if (find(request.name) !== undefined) {
        throw new EngineError(
          'create',
          `A container named ${request.name} already exists.`,
          { status: 409 },
        );
      }
      const id = randomBytes(32).toString('hex');
      containers.set(id, {
        agentId: spec.agentId,
        exitCode: null,
        id,
        request,
        runId: spec.runId,
        status: 'created',
      });
      return { id };
    },

    async start(id) {
      injected('start');
      const container = existing('start', id);
      container.status = 'running';
      container.exitCode = null;
    },

    async inspect(id): Promise<ContainerInfo | null> {
      injected('inspect');
      const container = find(id);
      if (container === undefined) {
        return null;
      }
      return {
        agentId: container.agentId,
        exitCode: container.exitCode,
        id: container.id,
        name: container.request.name,
        runId: container.runId,
        status: container.status,
      };
    },

    async stop(id, options) {
      stopTimeoutSeconds(options);
      injected('stop');
      const container = existing('stop', id);
      if (container.status === 'running' || container.status === 'paused') {
        container.status = 'exited';
        container.exitCode = 143;
      }
    },

    async remove(id) {
      injected('remove');
      const container = existing('remove', id);
      if (container.status === 'running' || container.status === 'paused') {
        throw new EngineError(
          'remove',
          `Container ${id} is running; stop it before removing it.`,
          { status: 409 },
        );
      }
      containers.delete(container.id);
    },

    async containersOf(agentId) {
      requireAgentId(agentId);
      injected('list');
      return [...containers.values()]
        .filter((container) => container.agentId === agentId)
        .map((container) => container.id);
    },

    failNext(operation, error) {
      failures.set(operation, error);
    },

    requestFor(idOrName) {
      return find(idOrName)?.request;
    },
  };
}
