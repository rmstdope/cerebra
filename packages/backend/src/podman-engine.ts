import { request as httpRequest } from 'node:http';

import {
  agentContainerLabels,
  agentContainerRequest,
  containerStatuses,
  ContainerNotFoundError,
  EngineError,
  type ContainerEngine,
  type ContainerInfo,
  type ContainerStatus,
  type EngineOperation,
  type EngineSettings,
} from './engine.js';

export interface PodmanEngineSettings extends EngineSettings {
  /** The rootless Podman API socket, bind-mounted into the main container. */
  readonly socketPath: string;
  readonly requestTimeoutMs?: number;
}

interface EngineReply {
  readonly status: number;
  readonly body: string;
}

const apiPrefix = '/v1.44';
const defaultRequestTimeoutMs = 30_000;
const defaultStopTimeoutSeconds = 10;

/** The container engine over rootless Podman's Docker-compatible REST API. */
export function createPodmanEngine(
  settings: PodmanEngineSettings,
): ContainerEngine {
  const requestTimeoutMs = settings.requestTimeoutMs ?? defaultRequestTimeoutMs;

  function call(
    operation: EngineOperation,
    method: string,
    path: string,
    options: { readonly body?: unknown; readonly timeoutMs?: number } = {},
  ): Promise<EngineReply> {
    const payload =
      options.body === undefined ? undefined : JSON.stringify(options.body);
    const timeoutMs = options.timeoutMs ?? requestTimeoutMs;

    return new Promise((resolve, reject) => {
      const outgoing = httpRequest(
        {
          headers: {
            Host: 'podman',
            ...(payload === undefined
              ? {}
              : {
                  'Content-Length': Buffer.byteLength(payload),
                  'Content-Type': 'application/json',
                }),
          },
          method,
          path: `${apiPrefix}${path}`,
          socketPath: settings.socketPath,
        },
        (incoming) => {
          const chunks: Buffer[] = [];
          incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
          incoming.on('error', (cause) =>
            reject(
              new EngineError(
                operation,
                `The container engine's answer to ${operation} was cut off.`,
                { cause },
              ),
            ),
          );
          incoming.on('end', () =>
            resolve({
              body: Buffer.concat(chunks).toString('utf8'),
              status: incoming.statusCode ?? 0,
            }),
          );
        },
      );
      outgoing.setTimeout(timeoutMs, () => {
        outgoing.destroy(
          new EngineError(
            operation,
            `The container engine at ${settings.socketPath} did not answer ${operation} within ${timeoutMs} ms.`,
          ),
        );
      });
      outgoing.on('error', (cause) => {
        reject(
          cause instanceof EngineError
            ? cause
            : new EngineError(
                operation,
                `The container engine is unreachable at ${settings.socketPath}: ${describe(cause)}.`,
                { cause },
              ),
        );
      });
      outgoing.end(payload);
    });
  }

  function refusal(
    operation: EngineOperation,
    reply: EngineReply,
    redact: readonly string[] = [],
  ): EngineError {
    let message = engineMessage(reply.body) ?? `HTTP ${reply.status}`;
    for (const secret of redact) {
      message = message.split(secret).join('[redacted]');
    }
    return new EngineError(
      operation,
      `The container engine refused ${operation}: ${message}`,
      { status: reply.status },
    );
  }

  async function command(
    operation: 'start' | 'stop' | 'remove',
    id: string,
    method: string,
    path: string,
    timeoutMs?: number,
  ): Promise<void> {
    const reply = await call(operation, method, path, { timeoutMs });
    if (reply.status === 204 || reply.status === 304) {
      return;
    }
    if (reply.status === 404) {
      throw new ContainerNotFoundError(operation, id);
    }
    throw refusal(operation, reply);
  }

  return {
    async create(spec) {
      const request = agentContainerRequest(spec, settings);
      const reply = await call(
        'create',
        'POST',
        `/containers/create?name=${encodeURIComponent(request.name)}`,
        { body: request.body },
      );
      if (reply.status !== 201) {
        throw refusal(
          'create',
          reply,
          Object.values(spec.environment).filter((value) => value !== ''),
        );
      }
      const id = parse('create', reply.body, (value) =>
        isRecord(value) && typeof value.Id === 'string' && value.Id !== ''
          ? value.Id
          : undefined,
      );
      return { id };
    },

    start(id) {
      return command('start', id, 'POST', `/containers/${ref(id)}/start`);
    },

    async inspect(id) {
      const reply = await call('inspect', 'GET', `/containers/${ref(id)}/json`);
      if (reply.status === 404) {
        return null;
      }
      if (reply.status !== 200) {
        throw refusal('inspect', reply);
      }
      return parse('inspect', reply.body, containerInfo);
    },

    stop(id, options = {}) {
      const seconds = options.timeoutSeconds ?? defaultStopTimeoutSeconds;
      return command(
        'stop',
        id,
        'POST',
        `/containers/${ref(id)}/stop?t=${seconds}`,
        seconds * 1000 + requestTimeoutMs,
      );
    },

    remove(id) {
      return command('remove', id, 'DELETE', `/containers/${ref(id)}`);
    },
  };
}

function ref(id: string): string {
  return encodeURIComponent(id);
}

function parse<T>(
  operation: EngineOperation,
  body: string,
  read: (value: unknown) => T | undefined,
): T {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch (cause) {
    throw new EngineError(
      operation,
      `The container engine's answer to ${operation} was not JSON.`,
      { cause },
    );
  }
  const result = read(value);
  if (result === undefined) {
    throw new EngineError(
      operation,
      `The container engine's answer to ${operation} was not understood.`,
    );
  }
  return result;
}

function containerInfo(value: unknown): ContainerInfo | undefined {
  if (
    !isRecord(value) ||
    typeof value.Id !== 'string' ||
    typeof value.Name !== 'string' ||
    !isRecord(value.State) ||
    typeof value.State.Status !== 'string' ||
    !containerStatuses.includes(value.State.Status as ContainerStatus)
  ) {
    return undefined;
  }
  const status = value.State.Status as ContainerStatus;
  const exitCode = value.State.ExitCode;
  const labels =
    isRecord(value.Config) && isRecord(value.Config.Labels)
      ? value.Config.Labels
      : {};
  const label = (key: string) =>
    typeof labels[key] === 'string' ? labels[key] : null;
  const ended = status === 'exited' || status === 'dead';
  if (ended && typeof exitCode !== 'number') {
    return undefined;
  }

  return {
    agentId: label(agentContainerLabels.agent),
    exitCode: ended ? (exitCode as number) : null,
    id: value.Id,
    name: value.Name.replace(/^\//, ''),
    runId: label(agentContainerLabels.run),
    status,
  };
}

function engineMessage(body: string): string | undefined {
  try {
    const value: unknown = JSON.parse(body);
    return isRecord(value) && typeof value.message === 'string'
      ? value.message
      : undefined;
  } catch {
    return undefined;
  }
}

function describe(error: Error): string {
  const code = (error as NodeJS.ErrnoException).code;
  return code === undefined ? error.message : `${code} (${error.message})`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
