export interface EngineSettings {
  /** The volume holding `/data`; agent mounts are subpaths of it. */
  readonly dataVolume: string;
  /** Joins the main container and agent containers only (architecture §2). */
  readonly internalNetwork: string;
  readonly egressNetwork: string;
  /** Non-root `uid[:gid]` or user name the agent runs as; defaults to `1000:1000`. */
  readonly user?: string;
}

export interface AgentContainerResources {
  readonly cpus: number;
  readonly memoryBytes: number;
}

export interface AgentContainerSpec {
  readonly runId: string;
  readonly agentId: string;
  readonly image: string;
  readonly command?: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly resources: AgentContainerResources;
}

export type ContainerStatus =
  | 'created'
  | 'running'
  | 'paused'
  | 'restarting'
  | 'removing'
  | 'exited'
  | 'dead';

export const containerStatuses: readonly ContainerStatus[] = [
  'created',
  'running',
  'paused',
  'restarting',
  'removing',
  'exited',
  'dead',
];

export interface ContainerInfo {
  readonly id: string;
  readonly name: string;
  readonly status: ContainerStatus;
  /** Set once the container has exited; `null` while it has not. */
  readonly exitCode: number | null;
  readonly runId: string | null;
  readonly agentId: string | null;
}

export interface StopOptions {
  readonly timeoutSeconds?: number;
}

export interface ContainerEngine {
  create(spec: AgentContainerSpec): Promise<{ readonly id: string }>;
  start(id: string): Promise<void>;
  /** `null` only when the engine says the container does not exist; every failure throws. */
  inspect(id: string): Promise<ContainerInfo | null>;
  /** Succeeds on a container that is already stopped. */
  stop(id: string, options?: StopOptions): Promise<void>;
  /** Refuses a running container: stop it first. */
  remove(id: string): Promise<void>;
}

export type EngineOperation =
  'create' | 'start' | 'inspect' | 'stop' | 'remove';

export class EngineError extends Error {
  readonly operation: EngineOperation;
  readonly status: number | undefined;

  constructor(
    operation: EngineOperation,
    message: string,
    options: { readonly status?: number; readonly cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'EngineError';
    this.operation = operation;
    this.status = options.status;
  }
}

export class ContainerNotFoundError extends EngineError {
  readonly containerId: string;

  constructor(operation: EngineOperation, containerId: string) {
    super(operation, `No container ${containerId} to ${operation}.`, {
      status: 404,
    });
    this.name = 'ContainerNotFoundError';
    this.containerId = containerId;
  }
}

export class InvalidContainerSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidContainerSpecError';
  }
}

export const agentContainerPaths = {
  cliState: '/cli-state',
  home: '/home/agent',
  tmp: '/tmp',
  work: '/work',
} as const;

export const agentContainerLabels = {
  agent: 'cerebra.agent',
  run: 'cerebra.run',
} as const;

export const defaultAgentUser = '1000:1000';

interface VolumeMount {
  readonly ReadOnly: boolean;
  readonly Source: string;
  readonly Target: string;
  readonly Type: 'volume';
  readonly VolumeOptions: { readonly Subpath: string };
}

/** The Docker-compatible `POST /containers/create` request for one run. */
export interface AgentContainerRequest {
  readonly name: string;
  readonly body: {
    readonly Image: string;
    readonly Cmd?: readonly string[];
    readonly Env: readonly string[];
    readonly Labels: Readonly<Record<string, string>>;
    readonly User: string;
    readonly HostConfig: {
      readonly CapDrop: readonly ['ALL'];
      readonly Memory: number;
      readonly Mounts: readonly VolumeMount[];
      readonly NanoCpus: number;
      readonly Privileged: false;
      readonly ReadonlyRootfs: true;
      readonly SecurityOpt: readonly ['no-new-privileges'];
      readonly Tmpfs: Readonly<Record<string, string>>;
    };
    readonly NetworkingConfig: {
      readonly EndpointsConfig: Readonly<Record<string, object>>;
    };
  };
}

const safeId = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const environmentName = /^[A-Za-z_][A-Za-z0-9_]*$/;
const validUser = /^[^\s:]*(?::[^\s:]*)?$/;
const rootUser = /^(?:root|0+)$/;

export const defaultStopTimeoutSeconds = 10;

/** The grace period a stop gives the container before it is killed. */
export function stopTimeoutSeconds(options: StopOptions = {}): number {
  const seconds = options.timeoutSeconds ?? defaultStopTimeoutSeconds;
  if (!Number.isSafeInteger(seconds) || seconds < 0) {
    throw new RangeError(
      'A stop timeout must be a whole number of seconds, zero or more.',
    );
  }
  return seconds;
}

export function agentContainerName(runId: string): string {
  requireSafeId('run id', runId);
  return `cerebra-run-${runId}`;
}

export function agentContainerRequest(
  spec: AgentContainerSpec,
  settings: EngineSettings,
): AgentContainerRequest {
  requireSafeId('run id', spec.runId);
  requireSafeId('agent id', spec.agentId);
  requireText('image', spec.image);
  requireText('data volume', settings.dataVolume);
  requireText('internal network', settings.internalNetwork);
  requireText('egress network', settings.egressNetwork);
  if (settings.internalNetwork === settings.egressNetwork) {
    throw new InvalidContainerSpecError(
      'The internal and egress networks must be different networks.',
    );
  }

  const user = settings.user ?? defaultAgentUser;
  const uid = user.split(':')[0] ?? '';
  if (!validUser.test(user) || uid === '' || rootUser.test(uid)) {
    throw new InvalidContainerSpecError(
      'Agent containers must run as a non-root user.',
    );
  }

  const { cpus, memoryBytes } = spec.resources;
  if (!Number.isFinite(cpus) || cpus <= 0) {
    throw new InvalidContainerSpecError(
      'An agent container needs a positive CPU limit.',
    );
  }
  if (!Number.isSafeInteger(memoryBytes) || memoryBytes <= 0) {
    throw new InvalidContainerSpecError(
      'An agent container needs a positive whole-byte memory limit.',
    );
  }

  const env = Object.entries(spec.environment).map(([name, value]) => {
    if (!environmentName.test(name)) {
      throw new InvalidContainerSpecError(
        `The environment variable name ${JSON.stringify(name)} is not valid.`,
      );
    }
    if (value.includes('\u0000')) {
      throw new InvalidContainerSpecError(
        `The value of the environment variable ${name} contains a NUL character.`,
      );
    }
    return `${name}=${value}`;
  });

  const volume = (target: string, subpath: string): VolumeMount => ({
    ReadOnly: false,
    Source: settings.dataVolume,
    Target: target,
    Type: 'volume',
    VolumeOptions: { Subpath: subpath },
  });

  return {
    body: {
      Image: spec.image,
      ...(spec.command === undefined ? {} : { Cmd: [...spec.command] }),
      Env: env,
      HostConfig: {
        CapDrop: ['ALL'],
        Memory: memoryBytes,
        Mounts: [
          volume(agentContainerPaths.work, `runs/${spec.runId}/checkout`),
          volume(agentContainerPaths.home, `agents/${spec.agentId}/home`),
          volume(
            agentContainerPaths.cliState,
            `agents/${spec.agentId}/cli-state`,
          ),
        ],
        NanoCpus: Math.round(cpus * 1e9),
        Privileged: false,
        ReadonlyRootfs: true,
        SecurityOpt: ['no-new-privileges'],
        Tmpfs: { [agentContainerPaths.tmp]: 'rw,nosuid,nodev,size=256m' },
      },
      Labels: {
        [agentContainerLabels.agent]: spec.agentId,
        [agentContainerLabels.run]: spec.runId,
      },
      NetworkingConfig: {
        EndpointsConfig: {
          [settings.egressNetwork]: {},
          [settings.internalNetwork]: {},
        },
      },
      User: user,
    },
    name: agentContainerName(spec.runId),
  };
}

function requireSafeId(what: string, value: string): void {
  if (!safeId.test(value)) {
    throw new InvalidContainerSpecError(
      `The ${what} ${JSON.stringify(value)} may only contain letters, digits, '.', '_' and '-', and must start with a letter or digit.`,
    );
  }
}

function requireText(what: string, value: string): void {
  if (value.trim() === '') {
    throw new InvalidContainerSpecError(`An agent container needs a ${what}.`);
  }
}
