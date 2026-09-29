import { describe, expect, test } from 'vitest';

import { exitCodeFor, readRunnerConfig } from './runner-config.js';

describe('the runner configuration', () => {
  test('comes from the environment the supervisor started the container with', () => {
    expect(
      readRunnerConfig({
        CEREBRA_GATEWAY_URL: 'ws://cerebra:4318/runner',
        CEREBRA_RUN_TOKEN: 'token',
        CLAUDE_CONFIG_DIR: '/state',
      }),
    ).toEqual({
      gatewayUrl: 'ws://cerebra:4318/runner',
      token: 'token',
      configDir: '/state',
      checkout: '/work',
    });
  });

  test('keeps Claude state in the CLI state volume unless told otherwise', () => {
    expect(
      readRunnerConfig({
        CEREBRA_GATEWAY_URL: 'ws://g',
        CEREBRA_RUN_TOKEN: 't',
      }).configDir,
    ).toBe('/cli-state');
  });

  test('names what is missing', () => {
    expect(() => readRunnerConfig({ CEREBRA_RUN_TOKEN: 't' })).toThrow(
      'CEREBRA_GATEWAY_URL is not set',
    );
    expect(() =>
      readRunnerConfig({
        CEREBRA_GATEWAY_URL: 'ws://g',
        CEREBRA_RUN_TOKEN: '',
      }),
    ).toThrow('CEREBRA_RUN_TOKEN is not set');
  });

  test('exits cleanly only for a run that completed or was stopped', () => {
    expect(exitCodeFor('completed')).toBe(0);
    expect(exitCodeFor('stopped')).toBe(0);
    expect(exitCodeFor('failed')).toBe(1);
    expect(exitCodeFor('turn')).toBe(1);
  });
});
