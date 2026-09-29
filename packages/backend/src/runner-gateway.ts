import { createHash, randomBytes } from 'node:crypto';
import type { Socket } from 'node:net';
import {
  RunnerProtocolError,
  parseUpMessage,
  runnerProtocol,
  type DownMessage,
  type UpMessage,
} from '@cerebra/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/** A fresh run token for a runner's environment; only the hash is stored (architecture §10). */
export function createRunToken(): {
  readonly token: string;
  readonly hash: string;
} {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashRunToken(token) };
}

export function hashRunToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface RunnerConnection<Run> {
  readonly run: Run;
  send(message: DownMessage): void;
  close(): void;
}

export interface RunnerClosed {
  readonly code: number;
  /** What was wrong with a message the runner sent, when that is why it was closed. */
  readonly problem?: string;
}

/** What a run does with its runner's messages; the gateway only checks and routes them. */
export interface RunnerListener {
  message(message: UpMessage): void;
  closed(reason: RunnerClosed): void;
}

export interface RunnerGatewayOptions<Run extends { readonly id: string }> {
  /** The run a token hash belongs to, if it is live. */
  authenticate(tokenHash: string): Promise<Run | null> | Run | null;
  accept(connection: RunnerConnection<Run>): RunnerListener;
}

export interface RunnerGateway {
  routes(server: FastifyInstance): void;
}

const policyViolation = 1008;
/** A close frame's reason is at most 123 bytes. */
function closeReason(text: string): string {
  let reason = text;
  while (Buffer.byteLength(reason) > 123) {
    reason = reason.slice(0, -1);
  }
  return reason;
}

function bearer(header: string | undefined): string | undefined {
  const match = /^Bearer (\S+)$/.exec(header ?? '');
  return match?.[1];
}

/**
 * The endpoint runners connect to (architecture §5.2). It authenticates with the run token, not
 * the navigator's session, and allows one connection per run.
 */
export function createRunnerGateway<Run extends { readonly id: string }>(
  options: RunnerGatewayOptions<Run>,
): RunnerGateway {
  // Held from authentication until the connection's socket closes, so two upgrades cannot race.
  const connected = new Map<string, Socket>();
  const admitted = new WeakMap<FastifyRequest, Run>();

  async function admit(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const token = bearer(request.headers.authorization);
    const run =
      token === undefined
        ? null
        : await options.authenticate(hashRunToken(token));
    if (run === null) {
      return reply.status(401).send({ error: 'Unknown run token.' });
    }
    if (request.headers['sec-websocket-protocol'] !== runnerProtocol) {
      return reply.status(400).send({ error: `Speak ${runnerProtocol}.` });
    }
    if (connected.has(run.id)) {
      return reply
        .status(409)
        .send({ error: 'This run already has a runner connected.' });
    }
    const socket = request.raw.socket;
    connected.set(run.id, socket);
    socket.once('close', () => {
      if (connected.get(run.id) === socket) {
        connected.delete(run.id);
      }
    });
    admitted.set(request, run);
  }

  return {
    routes(server) {
      server.get(
        '/runner',
        { preValidation: admit, websocket: true },
        (socket, request) => {
          const run = admitted.get(request);
          if (run === undefined) {
            socket.close(policyViolation);
            return;
          }
          let problem: string | undefined;
          const listener = options.accept({
            run,
            send: (message) => socket.send(JSON.stringify(message)),
            close: () => socket.close(1000),
          });
          socket.on('message', (data: Buffer) => {
            if (problem !== undefined) {
              return;
            }
            let message: UpMessage;
            try {
              message = parseUpMessage(String(data));
            } catch (error) {
              problem =
                error instanceof RunnerProtocolError
                  ? error.message
                  : 'The message could not be read';
              socket.close(policyViolation, closeReason(problem));
              return;
            }
            listener.message(message);
          });
          socket.once('close', (code: number) => {
            if (connected.get(run.id) === request.raw.socket) {
              connected.delete(run.id);
            }
            listener.closed(
              problem === undefined ? { code } : { code, problem },
            );
          });
        },
      );
    },
  };
}
