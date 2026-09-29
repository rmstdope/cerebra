import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { Kysely } from 'kysely';

import type { Database } from './database.js';
import { createProjectTokenCipher } from './project-token.js';
import {
  GitHubAccessError,
  ProjectMirrorError,
  ProjectRegistrationService,
  type Project,
  type ProjectStore,
} from './projects.js';
import { createDefaultFleet } from './fleet.js';
import { redactGitError } from './git-errors.js';
import { GitCommandError, runGit } from './git.js';

export function listProjects(database: Kysely<Database>): Promise<Project[]> {
  return database
    .selectFrom('projects')
    .select([
      'id',
      'owner',
      'name',
      'key_prefix as prefix',
      'default_branch as defaultBranch',
      'remote',
    ])
    .orderBy('owner')
    .orderBy('name')
    .orderBy('id')
    .execute();
}

function authorizationValue(credential: string): string {
  return ['Bearer', credential].join(' ');
}

export async function cloneMirror(
  remote: string,
  path: string,
  credential: string,
): Promise<void> {
  try {
    await runGit(['clone', '--mirror', remote, path], { credential });
  } catch (error) {
    if (!(error instanceof GitCommandError)) throw error;
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'git.clone.failed',
        repository: redactGitError(remote, credential),
        exitCode: error.exitCode,
        signal: error.signal,
        errorCode: error.errorCode,
        stderr: error.diagnostic,
        message: error.message,
      }),
    );
    throw new ProjectMirrorError(error.message);
  }
}

/** Stores a registered project together with its default fleet, or neither. */
export function createProjectStore(options: {
  readonly database: Kysely<Database>;
  readonly masterKey: string;
}): ProjectStore {
  const cipher = createProjectTokenCipher(options.masterKey);
  return {
    async create({ credential, project }) {
      const token = cipher.encrypt(credential);
      await options.database.transaction().execute(async (transaction) => {
        await transaction
          .insertInto('projects')
          .values({
            default_branch: project.defaultBranch,
            github_token_ciphertext: token.ciphertext,
            github_token_iv: token.iv,
            github_token_tag: token.tag,
            id: project.id,
            key_prefix: project.prefix,
            name: project.name,
            owner: project.owner,
            remote: project.remote,
          })
          .executeTakeFirstOrThrow();
        await createDefaultFleet(transaction, project.id);
      });
      return project;
    },
  };
}

export function createProjectRegistrationService(options: {
  readonly dataDirectory: string;
  readonly database: Kysely<Database>;
  readonly masterKey: string;
}): ProjectRegistrationService {
  const mirrorPath = (project: Project) =>
    join(options.dataDirectory, 'projects', project.id, 'mirror.git');

  return new ProjectRegistrationService({
    mirror: {
      async create({ credential, project }) {
        const path = mirrorPath(project);
        await fs.mkdir(join(path, '..'), { recursive: true });
        try {
          await cloneMirror(project.remote, path, credential);
        } catch (error) {
          await fs.rm(join(path, '..'), { force: true, recursive: true });
          throw error;
        }
      },
      async remove(project) {
        await fs.rm(join(mirrorPath(project), '..'), {
          force: true,
          recursive: true,
        });
      },
    },
    repository: {
      async discover({ credential, remote }) {
        const url = new URL(remote);
        const [owner, nameWithSuffix] = url.pathname.split('/').filter(Boolean);
        const name = nameWithSuffix.replace(/\.git$/, '');
        const headers = new Headers();
        headers.set('authorization', authorizationValue(credential));
        const response = await fetch(
          `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
          { headers },
        );
        if (!response.ok) {
          throw new GitHubAccessError();
        }
        const body = (await response.json()) as { default_branch?: unknown };
        if (typeof body.default_branch !== 'string') {
          throw new GitHubAccessError();
        }
        return { defaultBranch: body.default_branch, name, owner, remote };
      },
    },
    store: createProjectStore(options),
  });
}
