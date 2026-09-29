import type { ResultEnd } from '@cerebra/shared';

export interface RunnerConfig {
  readonly gatewayUrl: string;
  readonly token: string;
  /** Claude's CLI state: the run's login and transcripts, where its skills go. */
  readonly configDir: string;
  /** The run's checkout, mounted by the supervisor. */
  readonly checkout: string;
}

function required(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set`);
  }
  return value;
}

export function readRunnerConfig(
  env: Readonly<Record<string, string | undefined>>,
): RunnerConfig {
  return {
    gatewayUrl: required(env, 'CEREBRA_GATEWAY_URL'),
    token: required(env, 'CEREBRA_RUN_TOKEN'),
    configDir: env.CLAUDE_CONFIG_DIR || '/cli-state',
    checkout: '/work',
  };
}

export function exitCodeFor(end: ResultEnd): number {
  return end === 'completed' || end === 'stopped' ? 0 : 1;
}
