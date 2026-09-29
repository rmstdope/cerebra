import type { Kysely } from 'kysely';

import type { Database } from './database.js';
import { createProjectTokenCipher } from './project-token.js';

/** A pull request as the backend's merge decision needs it (architecture §8). */
export interface ForgePullRequest {
  readonly branch: string;
  readonly head: string;
  /** False when it conflicts with its base; null while the forge is still working it out. */
  readonly mergeable: boolean | null;
  readonly state: 'closed' | 'merged' | 'open';
}

/** Every check run and status on a revision, taken together; each one counts as required. */
export type ForgeChecks =
  | { readonly status: 'pending' }
  | { readonly status: 'success' }
  | { readonly check: string; readonly status: 'failure' };

export type ForgeMerge =
  | { readonly merged: true }
  | { readonly merged: false; readonly reason: 'head_moved' | 'not_mergeable' };

/**
 * The one boundary between the backend and a project's code host (architecture §8), always with
 * the project's own token, never a run's.
 */
export interface Forge {
  checks(sha: string): Promise<ForgeChecks>;
  closePullRequest(number: number, comment: string): Promise<void>;
  deleteBranch(branch: string): Promise<void>;
  /** Merges only if the head is still `sha`. */
  merge(number: number, sha: string): Promise<ForgeMerge>;
  pullRequest(number: number): Promise<ForgePullRequest>;
}

/** The forge a project's pull requests live on. */
export type ProjectForge = (projectId: string) => Promise<Forge>;

export class ForgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForgeError';
  }
}

const passedConclusions = new Set(['neutral', 'skipped', 'success']);

export function createGitHubForge(options: {
  readonly fetch?: typeof fetch;
  readonly remote: string;
  readonly token: string;
}): Forge {
  const repository = /github\.com[/:]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(
    options.remote,
  )?.[1];
  if (repository === undefined) {
    throw new ForgeError('The project’s remote is not a GitHub repository.');
  }
  const request = options.fetch ?? fetch;
  const call = async (
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> => {
    const headers = new Headers({
      accept: 'application/vnd.github+json',
      authorization: ['Bearer', options.token].join(' '),
    });
    if (body !== undefined) headers.set('content-type', 'application/json');
    try {
      return await request(
        `https://api.github.com/repos/${repository}${path}`,
        {
          body: body === undefined ? undefined : JSON.stringify(body),
          headers,
          method,
        },
      );
    } catch {
      throw new ForgeError(
        `GitHub could not be reached for ${method} ${path}.`,
      );
    }
  };
  const read = async (path: string): Promise<Record<string, unknown>> => {
    const response = await call('GET', path);
    if (!response.ok) {
      throw new ForgeError(`GitHub answered ${response.status} for ${path}.`);
    }
    return (await response.json()) as Record<string, unknown>;
  };
  const write = async (method: string, path: string, body?: unknown) => {
    const response = await call(method, path, body);
    if (!response.ok) {
      throw new ForgeError(
        `GitHub answered ${response.status} for ${method} ${path}.`,
      );
    }
  };

  return {
    async checks(sha) {
      const [runs, combined] = await Promise.all([
        read(`/commits/${sha}/check-runs?per_page=100`),
        read(`/commits/${sha}/status`),
      ]);
      const results = [
        ...(
          (runs.check_runs ?? []) as {
            conclusion: string | null;
            name: string;
            status: string;
          }[]
        ).map((run) => ({
          name: run.name,
          result:
            run.status !== 'completed'
              ? 'pending'
              : passedConclusions.has(run.conclusion ?? '')
                ? 'success'
                : 'failure',
        })),
        ...(
          (combined.statuses ?? []) as { context: string; state: string }[]
        ).map((status) => ({
          name: status.context,
          result:
            status.state === 'success'
              ? 'success'
              : status.state === 'pending'
                ? 'pending'
                : 'failure',
        })),
      ];
      const failed = results.find((result) => result.result === 'failure');
      if (failed !== undefined) {
        return { check: failed.name, status: 'failure' };
      }
      if (
        results.length === 0 ||
        results.some((result) => result.result === 'pending')
      ) {
        return { status: 'pending' };
      }
      return { status: 'success' };
    },

    async closePullRequest(number, comment) {
      await write('POST', `/issues/${number}/comments`, { body: comment });
      await write('PATCH', `/pulls/${number}`, { state: 'closed' });
    },

    async deleteBranch(branch) {
      const path = `/git/refs/heads/${branch.split('/').map(encodeURIComponent).join('/')}`;
      const response = await call('DELETE', path);
      // 422 is GitHub's answer for a branch that is already gone.
      if (!response.ok && response.status !== 422) {
        throw new ForgeError(`GitHub answered ${response.status} for ${path}.`);
      }
    },

    async merge(number, sha) {
      const response = await call('PUT', `/pulls/${number}/merge`, {
        merge_method: 'squash',
        sha,
      });
      if (response.status === 409)
        return { merged: false, reason: 'head_moved' };
      if (response.status === 405) {
        return { merged: false, reason: 'not_mergeable' };
      }
      if (!response.ok) {
        throw new ForgeError(
          `GitHub answered ${response.status} when merging #${number}.`,
        );
      }
      return { merged: true };
    },

    async pullRequest(number) {
      const body = await read(`/pulls/${number}`);
      const head = (body.head ?? {}) as { ref?: unknown; sha?: unknown };
      if (typeof head.sha !== 'string' || typeof head.ref !== 'string') {
        throw new ForgeError(
          `GitHub answered pull request #${number} without its head.`,
        );
      }
      return {
        branch: head.ref,
        head: head.sha,
        mergeable: typeof body.mergeable === 'boolean' ? body.mergeable : null,
        state:
          body.merged === true
            ? 'merged'
            : body.state === 'open'
              ? 'open'
              : 'closed',
      };
    },
  };
}

/** The GitHub forge for a registered project, with its decrypted token. */
export function projectGitHubForge(
  database: Kysely<Database>,
  masterKey: string,
): ProjectForge {
  const cipher = createProjectTokenCipher(masterKey);
  return async (projectId) => {
    const project = await database
      .selectFrom('projects')
      .select([
        'remote',
        'github_token_ciphertext',
        'github_token_iv',
        'github_token_tag',
      ])
      .where('id', '=', projectId)
      .executeTakeFirst();
    if (
      project?.remote == null ||
      project.github_token_ciphertext == null ||
      project.github_token_iv == null ||
      project.github_token_tag == null
    ) {
      throw new ForgeError(`Project ${projectId} has no GitHub repository.`);
    }
    let token: string;
    try {
      token = cipher.decrypt({
        ciphertext: project.github_token_ciphertext,
        iv: project.github_token_iv,
        tag: project.github_token_tag,
      });
    } catch {
      throw new ForgeError('The project’s GitHub token cannot be decrypted.');
    }
    return createGitHubForge({ remote: project.remote, token });
  };
}
