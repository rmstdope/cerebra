import { describe, expect, test } from 'vitest';

import {
  agentContainerName,
  agentContainerPaths,
  agentContainerRequest,
  InvalidContainerSpecError,
  type AgentContainerSpec,
  type EngineSettings,
} from './engine.js';

const settings: EngineSettings = {
  dataVolume: 'cerebra-data',
  egressNetwork: 'cerebro-egress',
  internalNetwork: 'cerebro-internal',
};

const spec: AgentContainerSpec = {
  agentId: 'agent-7',
  environment: { CEREBRA_RUN_TOKEN: 'secret-run-token' },
  image: 'localhost/cerebro-agent:latest',
  resources: { cpus: 1.5, memoryBytes: 2 * 1024 ** 3 },
  runId: 'run-42',
};

describe('the emitted agent container', () => {
  test('emits a non-root, read-only, capability-free container on the two agent networks', () => {
    const request = agentContainerRequest(spec, settings);

    expect(request.name).toBe('cerebra-run-run-42');
    expect(request.body.Image).toBe('localhost/cerebro-agent:latest');
    expect(request.body.User).toBe('1000:1000');
    expect(request.body.Env).toEqual(['CEREBRA_RUN_TOKEN=secret-run-token']);
    expect(request.body.Labels).toEqual({
      'cerebra.agent': 'agent-7',
      'cerebra.run': 'run-42',
    });
    expect(request.body.HostConfig).toEqual({
      CapDrop: ['ALL'],
      Memory: 2 * 1024 ** 3,
      Mounts: [
        {
          ReadOnly: false,
          Source: 'cerebra-data',
          Target: '/work',
          Type: 'volume',
          VolumeOptions: { Subpath: 'runs/run-42/checkout' },
        },
        {
          ReadOnly: false,
          Source: 'cerebra-data',
          Target: '/home/agent',
          Type: 'volume',
          VolumeOptions: { Subpath: 'agents/agent-7/home' },
        },
        {
          ReadOnly: false,
          Source: 'cerebra-data',
          Target: '/cli-state',
          Type: 'volume',
          VolumeOptions: { Subpath: 'agents/agent-7/cli-state' },
        },
      ],
      NanoCpus: 1_500_000_000,
      Privileged: false,
      ReadonlyRootfs: true,
      SecurityOpt: ['no-new-privileges'],
      Tmpfs: { '/tmp': 'rw,nosuid,nodev,size=256m' },
    });
    expect(request.body.NetworkingConfig).toEqual({
      EndpointsConfig: { 'cerebro-egress': {}, 'cerebro-internal': {} },
    });
    expect(request.body).not.toHaveProperty('Cmd');
  });

  test('passes an explicit command and a configured non-root user through', () => {
    const request = agentContainerRequest(
      { ...spec, command: ['sleep', '300'] },
      { ...settings, user: '2000:2000' },
    );

    expect(request.body.Cmd).toEqual(['sleep', '300']);
    expect(request.body.User).toBe('2000:2000');
  });

  test('names each container after its run and publishes the mount points', () => {
    expect(agentContainerName('run-42')).toBe('cerebra-run-run-42');
    expect(agentContainerPaths).toEqual({
      cliState: '/cli-state',
      home: '/home/agent',
      tmp: '/tmp',
      work: '/work',
    });
  });
});

describe('refusals', () => {
  test.each(['', '0', 'root', '0:0', 'root:1000', '0:1000', '00:5'])(
    'refuses the user %j',
    (user) => {
      expect(() => agentContainerRequest(spec, { ...settings, user })).toThrow(
        InvalidContainerSpecError,
      );
    },
  );

  test.each(['', '../x', 'a/b', '.hidden', 'x y', '-flag'])(
    'refuses the run or agent id %j',
    (id) => {
      expect(() =>
        agentContainerRequest({ ...spec, runId: id }, settings),
      ).toThrow(InvalidContainerSpecError);
      expect(() =>
        agentContainerRequest({ ...spec, agentId: id }, settings),
      ).toThrow(InvalidContainerSpecError);
    },
  );

  test.each([
    { cpus: 0, memoryBytes: 1 },
    { cpus: -1, memoryBytes: 1 },
    { cpus: Number.NaN, memoryBytes: 1 },
    { cpus: 1, memoryBytes: 0 },
    { cpus: 1, memoryBytes: 1.5 },
    { cpus: 1, memoryBytes: Number.POSITIVE_INFINITY },
  ])('refuses the resources %j', (resources) => {
    expect(() =>
      agentContainerRequest({ ...spec, resources }, settings),
    ).toThrow(InvalidContainerSpecError);
  });

  test('refuses an empty image and incomplete settings', () => {
    expect(() =>
      agentContainerRequest({ ...spec, image: '' }, settings),
    ).toThrow(InvalidContainerSpecError);
    for (const key of [
      'dataVolume',
      'internalNetwork',
      'egressNetwork',
    ] as const) {
      expect(() =>
        agentContainerRequest(spec, { ...settings, [key]: '' }),
      ).toThrow(InvalidContainerSpecError);
    }
    expect(() =>
      agentContainerRequest(spec, {
        ...settings,
        egressNetwork: settings.internalNetwork,
      }),
    ).toThrow(InvalidContainerSpecError);
  });

  test('refuses bad environment names and values without echoing a value', () => {
    for (const name of ['', '1ABC', 'A-B', 'A=B']) {
      expect(() =>
        agentContainerRequest(
          { ...spec, environment: { [name]: 'value' } },
          settings,
        ),
      ).toThrow(InvalidContainerSpecError);
    }

    let refusal: unknown;
    try {
      agentContainerRequest(
        { ...spec, environment: { TOKEN: 'top-secret\u0000value' } },
        settings,
      );
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(InvalidContainerSpecError);
    expect(String((refusal as Error).message)).toContain('TOKEN');
    expect(String((refusal as Error).message)).not.toContain('top-secret');
  });
});
