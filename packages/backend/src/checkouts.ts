import { lchown, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Kysely } from 'kysely';

import type { Database } from './database.js';
import { GitCommandError, runGit } from './git.js';
import { createProjectTokenCipher } from './project-token.js';
import { cloneMirror } from './project-registration.js';
import { isUuid } from './runs.js';

/** What the backend needs to fetch a project from GitHub; the credential is never given to a run. */
export interface ProjectGitAccess {
  readonly remote: string;
  readonly defaultBranch: string;
  readonly credential: string;
}

/** Per-run checkouts made from the backend's own mirror (architecture §7). */
export interface RunCheckouts {
  /**
   * Fetches the project's mirror and clones `base` (the default branch when absent) into the
   * run's checkout, with `origin` pointing at GitHub. Every failure is a `CheckoutError` and
   * leaves no run directory behind.
   */
  create(input: {
    readonly runId: string;
    readonly projectId: string;
    readonly base?: string;
  }): Promise<void>;
  /** Deletes the run's directory as a directory: no git runs in it, and no link is followed. */
  remove(runId: string): Promise<void>;
  /** Removes every run directory whose run is not in `live`; names that are not run ids stay. */
  sweep(live: ReadonlySet<string>): Promise<void>;
}

export class CheckoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CheckoutError';
  }
}

function failureText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function chownTree(
  path: string,
  owner: { readonly uid: number; readonly gid: number },
): Promise<void> {
  await lchown(path, owner.uid, owner.gid);
  for (const entry of await readdir(path, {
    recursive: true,
    withFileTypes: true,
  })) {
    await lchown(join(entry.parentPath, entry.name), owner.uid, owner.gid);
  }
}

function requireRunId(runId: string): void {
  if (!isUuid(runId)) throw new CheckoutError(`${runId} is not a run id.`);
}

export function createRunCheckouts(options: {
  readonly dataDirectory: string;
  readonly project: (projectId: string) => Promise<ProjectGitAccess>;
  /** Who the agent runs as; the checkout is given to it when the backend runs as root. */
  readonly owner?: { readonly uid: number; readonly gid: number };
  readonly gitTimeoutMs?: number;
}): RunCheckouts {
  const owner =
    options.owner ??
    (process.getuid?.() === 0 ? { gid: 1000, uid: 1000 } : undefined);
  const timeout =
    options.gitTimeoutMs === undefined
      ? {}
      : { timeoutMs: options.gitTimeoutMs };
  const runsDirectory = join(options.dataDirectory, 'runs');
  // One mirror is fetched and cloned from by one operation at a time.
  const mirrorLocks = new Map<string, Promise<unknown>>();

  function withMirror<T>(
    projectId: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const previous = mirrorLocks.get(projectId) ?? Promise.resolve();
    const next = previous.then(work, work);
    const settled = next.catch(() => undefined);
    mirrorLocks.set(projectId, settled);
    void settled.then(() => {
      if (mirrorLocks.get(projectId) === settled) mirrorLocks.delete(projectId);
    });
    return next;
  }

  async function updateMirror(
    projectId: string,
    access: ProjectGitAccess,
  ): Promise<string> {
    if (!isUuid(projectId)) {
      throw new CheckoutError(`${projectId} is not a project id.`);
    }
    const projectDirectory = join(options.dataDirectory, 'projects', projectId);
    const mirror = join(projectDirectory, 'mirror.git');
    try {
      if (await exists(mirror)) {
        await runGit(
          ['--git-dir', mirror, 'fetch', '--prune', '--quiet', 'origin'],
          {
            credential: access.credential,
            ...timeout,
          },
        );
      } else {
        // Mirrors are rebuilt, never backed up (architecture §10).
        await mkdir(projectDirectory, { recursive: true });
        await cloneMirror(access.remote, mirror, access.credential);
      }
    } catch (error) {
      throw new CheckoutError(
        `Cerebra could not fetch the latest code from GitHub: ${failureText(error)}`,
      );
    }
    return mirror;
  }

  async function requireBranch(mirror: string, base: string): Promise<void> {
    const missing = new CheckoutError(`The branch ${base} is not on GitHub.`);
    if (base === '' || base.startsWith('-')) throw missing;
    try {
      await runGit(
        [
          '--git-dir',
          mirror,
          'show-ref',
          '--verify',
          '--quiet',
          `refs/heads/${base}`,
        ],
        timeout,
      );
    } catch (error) {
      if (error instanceof GitCommandError && error.exitCode === 1)
        throw missing;
      throw new CheckoutError(
        `Cerebra could not read its copy of the repository: ${failureText(error)}`,
      );
    }
  }

  async function removeRunDirectory(runId: string): Promise<void> {
    await rm(join(runsDirectory, runId), { force: true, recursive: true });
  }

  return {
    async create({ runId, projectId, base }) {
      requireRunId(runId);
      const checkout = join(runsDirectory, runId, 'checkout');
      try {
        const access = await options.project(projectId);
        const branch = base ?? access.defaultBranch;
        await withMirror(projectId, async () => {
          const mirror = await updateMirror(projectId, access);
          await requireBranch(mirror, branch);
          await mkdir(join(runsDirectory, runId), { recursive: true });
          try {
            // --no-hardlinks: the checkout shares no file with the mirror, and needs no path to it.
            await runGit(
              [
                'clone',
                '--quiet',
                '--no-hardlinks',
                '--branch',
                branch,
                '--',
                mirror,
                checkout,
              ],
              timeout,
            );
            // The one git command inside the checkout, made before any agent has touched it.
            await runGit(
              [
                '--git-dir',
                join(checkout, '.git'),
                'config',
                'remote.origin.url',
                access.remote,
              ],
              timeout,
            );
          } catch (error) {
            throw new CheckoutError(
              `Cerebra could not make the run’s checkout: ${failureText(error)}`,
            );
          }
        });
        if (owner !== undefined)
          await chownTree(join(runsDirectory, runId), owner);
      } catch (error) {
        await removeRunDirectory(runId).catch(() => undefined);
        if (error instanceof CheckoutError) throw error;
        throw new CheckoutError(
          `Cerebra could not make the run’s checkout: ${failureText(error)}`,
        );
      }
    },

    async remove(runId) {
      requireRunId(runId);
      await removeRunDirectory(runId);
    },

    async sweep(live) {
      let names: string[];
      try {
        names = await readdir(runsDirectory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      for (const name of names) {
        if (isUuid(name) && !live.has(name)) await removeRunDirectory(name);
      }
    },
  };
}

/** Reads a registered project's remote, default branch and decrypted GitHub token. */
export function projectGitAccess(
  database: Kysely<Database>,
  masterKey: string,
): (projectId: string) => Promise<ProjectGitAccess> {
  const cipher = createProjectTokenCipher(masterKey);
  return async (projectId) => {
    const project = isUuid(projectId)
      ? await database
          .selectFrom('projects')
          .select([
            'remote',
            'default_branch',
            'github_token_ciphertext',
            'github_token_iv',
            'github_token_tag',
          ])
          .where('id', '=', projectId)
          .executeTakeFirst()
      : undefined;
    if (project === undefined) {
      throw new CheckoutError(`There is no project ${projectId}.`);
    }
    let credential: string;
    try {
      credential = cipher.decrypt({
        ciphertext: project.github_token_ciphertext,
        iv: project.github_token_iv,
        tag: project.github_token_tag,
      });
    } catch {
      throw new CheckoutError(
        'The project’s GitHub token cannot be decrypted. Register the project’s token again.',
      );
    }
    return {
      credential,
      defaultBranch: project.default_branch,
      remote: project.remote,
    };
  };
}
