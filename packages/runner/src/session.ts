import {
  parseDownMessage,
  runnerProtocol,
  type AgentEvent,
  type DownMessage,
  type ResultEnd,
  type StartMessage,
} from '@cerebra/shared';
import { WebSocket } from 'ws';

import {
  runClaude,
  type ClaudeQuery,
  type ClaudeRun,
} from './claude-adapter.js';
import { installProjectSkills } from './skills.js';

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One run, start to end: connects to the gateway, waits for `start`, drives Claude, and sends
 * everything that happens as numbered events (architecture §5.2). Resolves with how the run ended.
 * There is no reconnect in the MVP: losing the gateway fails the run.
 */
export function runRunnerSession(context: {
  readonly gatewayUrl: string;
  readonly token: string;
  /** Claude's CLI state directory, where the run's skills are installed. */
  readonly configDir: string;
  readonly checkout: string;
  readonly query: ClaudeQuery;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
  /** Diagnostics for the container's log; never given the environment or the token. */
  readonly log?: (message: string) => void;
}): Promise<ResultEnd> {
  return new Promise((resolve) => {
    const socket = new WebSocket(context.gatewayUrl, runnerProtocol, {
      headers: { Authorization: `Bearer ${context.token}` },
    });
    let seq = 0;
    let started = false;
    let run: ClaudeRun | undefined;
    let settled = false;
    const early: DownMessage[] = [];

    function emit(event: AgentEvent): void {
      if (socket.readyState === WebSocket.OPEN) {
        seq += 1;
        socket.send(JSON.stringify({ type: 'event', seq, event }));
      }
    }

    function settle(end: ResultEnd): void {
      if (!settled) {
        settled = true;
        socket.close(1000);
        resolve(end);
      }
    }

    function failWithoutRun(error: string): void {
      emit({
        kind: 'result',
        end: 'failed',
        usage: { costUsd: 0, models: {} },
        error,
      });
      settle('failed');
    }

    function deliver(active: ClaudeRun, message: DownMessage): void {
      try {
        switch (message.type) {
          case 'user_message':
            active.send(message.text);
            break;
          case 'answer':
            active.answer(message.questionId, message.answers);
            break;
          case 'interrupt':
            active.interrupt().catch((error: unknown) => {
              emit({ kind: 'error', message: reason(error) });
            });
            break;
          case 'stop':
            active.stop();
            break;
          case 'start':
            emit({ kind: 'error', message: 'The run has already started' });
            break;
        }
      } catch (error) {
        emit({ kind: 'error', message: reason(error) });
      }
    }

    async function begin(start: StartMessage): Promise<void> {
      let active: ClaudeRun;
      try {
        await installProjectSkills({
          checkout: context.checkout,
          configDir: context.configDir,
          names: start.skills,
        });
        if (settled || socket.readyState !== WebSocket.OPEN) {
          settle('failed');
          return;
        }
        active = runClaude({
          start,
          query: context.query,
          env: context.env,
          emit,
          ...(context.cwd === undefined ? {} : { cwd: context.cwd }),
        });
      } catch (error) {
        failWithoutRun(reason(error));
        return;
      }
      run = active;
      for (const message of early.splice(0)) {
        deliver(active, message);
      }
      settle(await active.done);
    }

    socket.on('message', (data) => {
      let message: DownMessage;
      try {
        message = parseDownMessage(String(data));
      } catch (error) {
        const unreadable = `The gateway sent a message the runner cannot read: ${reason(error)}`;
        if (run === undefined) {
          failWithoutRun(unreadable);
        } else {
          emit({ kind: 'error', message: unreadable });
          run.stop(unreadable);
        }
        return;
      }
      if (!started) {
        if (message.type !== 'start') {
          failWithoutRun(`The gateway sent ${message.type} before start`);
          return;
        }
        started = true;
        void begin(message);
      } else if (run === undefined) {
        early.push(message);
      } else {
        deliver(run, message);
      }
    });

    socket.on('error', (error) => {
      context.log?.(`The gateway connection failed: ${reason(error)}`);
    });

    socket.on('close', () => {
      if (run !== undefined) {
        run.stop('The gateway connection closed');
      } else if (!settled) {
        settled = true;
        resolve('failed');
      }
    });
  });
}
