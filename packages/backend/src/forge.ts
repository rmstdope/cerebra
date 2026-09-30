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
  /** Nothing has reported on the revision at all. */
  | { readonly status: 'none' }
  | { readonly status: 'pending' }
  | { readonly status: 'success' }
  | { readonly check: string; readonly status: 'failure' };

/** A submitted review on a pull request; pending drafts are never included. */
export interface ForgeReview {
  readonly body: string;
  readonly id: number;
  readonly login: string;
  readonly state: 'approved' | 'changes_requested' | 'commented' | 'dismissed';
  readonly submittedAt: Date;
  readonly url: string;
}

export interface ForgeReviewComment {
  readonly body: string;
  readonly file: string;
  readonly line?: number;
}

export type ForgeMerge =
  | { readonly merged: true }
  | { readonly merged: false; readonly reason: 'head_moved' }
  | {
      readonly merged: false;
      readonly message: string;
      readonly reason: 'refused';
    };

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
  reviewComments(
    number: number,
    reviewId: number,
  ): Promise<ForgeReviewComment[]>;
  /** Every submitted review, oldest first. */
  reviews(number: number): Promise<ForgeReview[]>;
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
  // Every page of a list, so a failing check on a later page is never missed.
  const readAll = async <T>(path: string, field: string): Promise<T[]> => {
    const all: T[] = [];
    for (let page = 1; ; page += 1) {
      const body = await read(`${path}?per_page=100&page=${page}`);
      const items = (body[field] ?? []) as T[];
      all.push(...items);
      const total =
        typeof body.total_count === 'number' ? body.total_count : all.length;
      if (items.length < 100 || all.length >= total) return all;
    }
  };
  // Every page of an endpoint that answers with a bare array.
  const readList = async <T>(path: string): Promise<T[]> => {
    const all: T[] = [];
    for (let page = 1; ; page += 1) {
      const response = await call('GET', `${path}?per_page=100&page=${page}`);
      if (!response.ok) {
        throw new ForgeError(`GitHub answered ${response.status} for ${path}.`);
      }
      const items = (await response.json()) as T[];
      if (!Array.isArray(items)) {
        throw new ForgeError(`GitHub answered ${path} without a list.`);
      }
      all.push(...items);
      if (items.length < 100) return all;
    }
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
      const [runs, statuses] = await Promise.all([
        readAll<{ conclusion: string | null; name: string; status: string }>(
          `/commits/${sha}/check-runs`,
          'check_runs',
        ),
        readAll<{ context: string; state: string }>(
          `/commits/${sha}/status`,
          'statuses',
        ),
      ]);
      const results = [
        ...runs.map((run) => ({
          name: run.name,
          result:
            run.status !== 'completed'
              ? 'pending'
              : passedConclusions.has(run.conclusion ?? '')
                ? 'success'
                : 'failure',
        })),
        ...statuses.map((status) => ({
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
      if (results.length === 0) return { status: 'none' };
      if (results.some((result) => result.result === 'pending')) {
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
        const body = (await response.json().catch(() => ({}))) as {
          message?: unknown;
        };
        return {
          merged: false,
          message:
            typeof body.message === 'string' && body.message !== ''
              ? body.message
              : 'GitHub gave no reason.',
          reason: 'refused',
        };
      }
      if (!response.ok) {
        throw new ForgeError(
          `GitHub answered ${response.status} when merging #${number}.`,
        );
      }
      return { merged: true };
    },

    async reviewComments(number, reviewId) {
      const comments = await readList<{
        body?: unknown;
        line?: unknown;
        original_line?: unknown;
        path?: unknown;
      }>(`/pulls/${number}/reviews/${reviewId}/comments`);
      return comments.map((comment) => {
        const line =
          typeof comment.line === 'number'
            ? comment.line
            : typeof comment.original_line === 'number'
              ? comment.original_line
              : undefined;
        return {
          body: typeof comment.body === 'string' ? comment.body : '',
          file: typeof comment.path === 'string' ? comment.path : '',
          ...(line === undefined ? {} : { line }),
        };
      });
    },

    async reviews(number) {
      const reviews = await readList<{
        body?: unknown;
        html_url?: unknown;
        id?: unknown;
        state?: unknown;
        submitted_at?: unknown;
        user?: { login?: unknown } | null;
      }>(`/pulls/${number}/reviews`);
      const states: Record<string, ForgeReview['state']> = {
        APPROVED: 'approved',
        CHANGES_REQUESTED: 'changes_requested',
        COMMENTED: 'commented',
        DISMISSED: 'dismissed',
      };
      return reviews.flatMap((review): ForgeReview[] => {
        const state = states[String(review.state)];
        if (
          state === undefined ||
          typeof review.id !== 'number' ||
          typeof review.submitted_at !== 'string' ||
          typeof review.user?.login !== 'string'
        ) {
          return [];
        }
        return [
          {
            body: typeof review.body === 'string' ? review.body : '',
            id: review.id,
            login: review.user.login,
            state,
            submittedAt: new Date(review.submitted_at),
            url: typeof review.html_url === 'string' ? review.html_url : '',
          },
        ];
      });
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
