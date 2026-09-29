import { spawn } from 'node:child_process';

import { gitErrorMessage, redactGitError } from './git-errors.js';

/** How long one git command may run before it is killed (architecture §7). */
export const defaultGitTimeoutMs = 10 * 60 * 1000;

const stderrLimitBytes = 64 * 1024;

export class GitCommandError extends Error {
  /** What git printed, redacted, for the log; never the credential. */
  readonly diagnostic: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  /** The spawn error's code, such as `ENOENT` when git is not installed. */
  readonly errorCode: string | undefined;

  constructor(
    message: string,
    details: {
      readonly diagnostic?: string;
      readonly exitCode?: number | null;
      readonly signal?: NodeJS.Signals | null;
      readonly errorCode?: string;
    } = {},
  ) {
    super(message);
    this.name = 'GitCommandError';
    this.diagnostic = details.diagnostic ?? '';
    this.exitCode = details.exitCode ?? null;
    this.signal = details.signal ?? null;
    this.errorCode = details.errorCode;
  }
}

function seconds(ms: number): string {
  const whole = Math.max(1, Math.ceil(ms / 1000));
  return whole === 1 ? '1 second' : `${whole} seconds`;
}

/**
 * The backend's one way to run git. A credential travels as an `http.extraheader` in the
 * environment, never on the command line or in a config file; the global and system config are
 * never read; and a command that outlives its bound is killed. Every failure is a
 * `GitCommandError` whose message and diagnostic are redacted.
 */
export function runGit(
  args: readonly string[],
  options: { readonly credential?: string; readonly timeoutMs?: number } = {},
): Promise<void> {
  const credential = options.credential ?? '';
  const timeoutMs = options.timeoutMs ?? defaultGitTimeoutMs;
  return new Promise((resolve, reject) => {
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    let errorCode: string | undefined;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      LC_ALL: 'C',
    };
    if (credential !== '') {
      env.GIT_CONFIG_COUNT = '1';
      env.GIT_CONFIG_KEY_0 = 'http.extraheader';
      env.GIT_CONFIG_VALUE_0 = [
        'Authorization:',
        'Basic',
        Buffer.from(`x-access-token:${credential}`).toString('base64'),
      ].join(' ');
    }
    const child = spawn('git', [...args], {
      detached: true,
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        // The whole group: a transport helper git started must not outlive it.
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, timeoutMs);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (truncated) return;
      stderr += chunk;
      if (Buffer.byteLength(stderr, 'utf8') > stderrLimitBytes) {
        // Discard the whole buffer rather than keep a partially captured secret.
        stderr = '';
        truncated = true;
      }
    });
    child.once('error', (error: NodeJS.ErrnoException) => {
      errorCode = error.code ?? 'UNKNOWN';
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0 && errorCode === undefined && !timedOut) {
        resolve();
        return;
      }
      if (timedOut) {
        reject(
          new GitCommandError(
            `Git did not finish within ${seconds(timeoutMs)} and was stopped.`,
            { exitCode: code, signal },
          ),
        );
        return;
      }
      const diagnostic = truncated
        ? 'Git error output exceeded the capture limit; details were omitted.'
        : redactGitError(stderr, credential);
      reject(
        new GitCommandError(gitErrorMessage(diagnostic, errorCode), {
          diagnostic,
          errorCode,
          exitCode: code,
          signal,
        }),
      );
    });
  });
}
