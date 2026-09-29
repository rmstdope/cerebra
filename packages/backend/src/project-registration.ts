import { spawn } from 'node:child_process';
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

function authorizationValue(credential: string): string {
  return ['Bearer', credential].join(' ');
}

function cloneMirror(
  remote: string,
  path: string,
  credential: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['clone', '--mirror', remote, path], {
      env: {
        ...process.env,
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'http.extraheader',
        GIT_CONFIG_VALUE_0: [
          'Authorization:',
          authorizationValue(credential),
        ].join(' '),
      },
      stdio: 'ignore',
    });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new ProjectMirrorError()),
    );
  });
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
