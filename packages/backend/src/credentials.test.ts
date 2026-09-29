import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { describe, expect, test } from 'vitest';

import { createBoard, ProjectNotFoundError } from './board.js';
import { createEnvelopeCipher } from './credential-cipher.js';
import {
  agentGitHubCredentialName,
  createCredentialService,
  CredentialInputError,
  CredentialNotFoundError,
  DuplicateDestinationError,
  modelCredentialName,
  type CredentialService,
} from './credentials.js';
import { createDatabase, type Database } from './database.js';
import { migrateToLatest } from './migrations/index.js';
import type { Kysely } from 'kysely';

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error('DATABASE_URL is required to run credential tests');
}

const masterKey = randomBytes(32).toString('base64');

interface Fixture {
  readonly database: Kysely<Database>;
  readonly credentials: CredentialService;
  readonly projectId: string;
  readonly otherProjectId: string;
}

async function withCredentials(
  run: (fixture: Fixture) => Promise<void>,
): Promise<void> {
  const schema = `cerebra_credentials_test_${crypto.randomUUID().replaceAll('-', '')}`;
  const pool = new Pool({ connectionString: databaseUrl });
  await pool.query(`CREATE SCHEMA "${schema}"`);
  const database = createDatabase(databaseUrl!, schema);
  try {
    await migrateToLatest(database, schema);
    const board = createBoard(database);
    const projectId = crypto.randomUUID();
    const otherProjectId = crypto.randomUUID();
    await board.createProject({ id: projectId, name: 'admin' });
    await board.createProject({ id: otherProjectId, name: 'mobile' });
    await database
      .updateTable('projects')
      .set({ owner: 'northstar' })
      .where('id', '=', projectId)
      .execute();
    await run({
      credentials: createCredentialService({
        cipher: createEnvelopeCipher(masterKey),
        database,
      }),
      database,
      otherProjectId,
      projectId,
    });
  } finally {
    await database.destroy();
    await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await pool.end();
  }
}

async function saveModelAndGitHub(
  credentials: CredentialService,
  projectId: string,
): Promise<void> {
  await credentials.save({
    name: modelCredentialName,
    scope: 'instance',
    value: 'claude-instance',
  });
  await credentials.save({
    name: agentGitHubCredentialName,
    projectId,
    scope: 'project',
    value: 'ghp-agent',
  });
}

describe('credential store', { concurrent: false }, () => {
  test('saves at both scopes and lists names and scopes without values', async () => {
    await withCredentials(async ({ credentials, database, projectId }) => {
      await credentials.save({
        name: 'Deploy key',
        projectId,
        scope: 'project',
        value: 'project-secret-value',
      });
      await credentials.save({
        name: 'Deploy key',
        scope: 'instance',
        value: 'instance-secret-value',
      });

      const overview = await credentials.overview(projectId);

      expect(overview.project).toEqual({
        id: projectId,
        name: 'northstar/admin',
      });
      expect(
        overview.projectCredentials.filter((row) => row.id !== null),
      ).toEqual([
        expect.objectContaining({
          lastUsedAt: null,
          name: 'Deploy key',
          needsAttention: false,
          scope: 'project',
        }),
      ]);
      expect(
        overview.instanceCredentials.filter((row) => row.id !== null),
      ).toEqual([
        expect.objectContaining({ name: 'Deploy key', scope: 'instance' }),
      ]);
      const serialised = JSON.stringify(overview);
      expect(serialised).not.toContain('secret-value');
      const stored = JSON.stringify(
        await database.selectFrom('credentials').selectAll().execute(),
      );
      expect(stored).not.toContain('secret-value');
    });
  });

  test('replaces the value of a matching name and scope', async () => {
    await withCredentials(async ({ credentials, database, projectId }) => {
      const first = await credentials.save({
        name: 'Deploy key',
        projectId,
        scope: 'project',
        value: 'one',
      });
      const second = await credentials.save({
        name: '  Deploy key ',
        projectId,
        scope: 'project',
        value: 'two',
      });

      expect(first).toEqual({ name: 'Deploy key', replaced: false });
      expect(second).toEqual({ name: 'Deploy key', replaced: true });
      expect(
        await database.selectFrom('credentials').select('id').execute(),
      ).toHaveLength(1);
    });
  });

  test('keeps a project credential to its own project', async () => {
    await withCredentials(
      async ({ credentials, otherProjectId, projectId }) => {
        await credentials.save({
          name: 'Deploy key',
          projectId,
          scope: 'project',
          value: 'x',
        });

        const other = await credentials.overview(otherProjectId);

        expect(
          other.projectCredentials.some((row) => row.name === 'Deploy key'),
        ).toBe(false);
      },
    );
  });

  test('refuses an empty name or value and an unknown project', async () => {
    await withCredentials(async ({ credentials, projectId }) => {
      await expect(
        credentials.save({ name: ' ', scope: 'instance', value: 'x' }),
      ).rejects.toBeInstanceOf(CredentialInputError);
      await expect(
        credentials.save({ name: 'A', scope: 'instance', value: '  ' }),
      ).rejects.toBeInstanceOf(CredentialInputError);
      await expect(
        credentials.save({ name: 'A', scope: 'project', value: 'x' }),
      ).rejects.toBeInstanceOf(CredentialInputError);
      await expect(
        credentials.save({
          name: 'A',
          projectId: crypto.randomUUID(),
          scope: 'project',
          value: 'x',
        }),
      ).rejects.toBeInstanceOf(ProjectNotFoundError);
      await expect(
        credentials.overview(crypto.randomUUID()),
      ).rejects.toBeInstanceOf(ProjectNotFoundError);
      await expect(
        credentials.save({
          name: 'A',
          projectId,
          scope: 'project',
          value: 'x'.repeat(10),
        }),
      ).resolves.toEqual({ name: 'A', replaced: false });
    });
  });

  test('removes a credential, and refuses one that does not exist', async () => {
    await withCredentials(async ({ credentials, projectId }) => {
      await credentials.save({
        name: 'Deploy key',
        projectId,
        scope: 'project',
        value: 'x',
      });
      const [row] = (await credentials.overview(projectId)).projectCredentials;

      await credentials.remove(row!.id!);

      expect(
        (await credentials.overview(projectId)).projectCredentials.some(
          (entry) => entry.name === 'Deploy key',
        ),
      ).toBe(false);
      await expect(credentials.remove(row!.id!)).rejects.toBeInstanceOf(
        CredentialNotFoundError,
      );
      await expect(credentials.remove('not-a-uuid')).rejects.toBeInstanceOf(
        CredentialNotFoundError,
      );
    });
  });
});

describe('agent credential deliveries', { concurrent: false }, () => {
  test('lists built-in and declared deliveries for an agent type', async () => {
    await withCredentials(async ({ credentials, projectId }) => {
      await saveModelAndGitHub(credentials, projectId);
      await credentials.save({
        name: 'Deploy key',
        scope: 'instance',
        value: 'x',
      });
      await credentials.setAgentCredentials(projectId, 'producer', [
        {
          credentialName: 'Deploy key',
          delivery: 'file',
          destination: '/run/secrets/deploy',
        },
      ]);

      const settings = await credentials.agentCredentials(
        projectId,
        'producer',
      );

      expect(settings.entries).toEqual([
        {
          builtIn: true,
          credentialName: modelCredentialName,
          delivery: 'environment',
          destination: 'CLAUDE_CODE_OAUTH_TOKEN',
          needsAttention: false,
        },
        {
          builtIn: true,
          credentialName: agentGitHubCredentialName,
          delivery: 'environment',
          destination: 'GH_TOKEN',
          needsAttention: false,
        },
        {
          builtIn: false,
          credentialName: 'Deploy key',
          delivery: 'file',
          destination: '/run/secrets/deploy',
          needsAttention: false,
        },
      ]);
      expect(settings.available).toEqual([
        'Claude sign-in token',
        'Deploy key',
        'GitHub access token',
      ]);
      expect(
        (await credentials.agentCredentials(projectId, 'reviewer')).entries.map(
          (entry) => entry.credentialName,
        ),
      ).toEqual([modelCredentialName]);
    });
  });

  test('refuses a destination already used by the agent type', async () => {
    await withCredentials(async ({ credentials, projectId }) => {
      await expect(
        credentials.setAgentCredentials(projectId, 'producer', [
          { credentialName: 'A', delivery: 'environment', destination: 'X' },
          { credentialName: 'B', delivery: 'environment', destination: 'X' },
        ]),
      ).rejects.toEqual(new DuplicateDestinationError('X'));
      await expect(
        credentials.setAgentCredentials(projectId, 'producer', [
          {
            credentialName: 'A',
            delivery: 'environment',
            destination: 'GH_TOKEN',
          },
        ]),
      ).rejects.toEqual(new DuplicateDestinationError('GH_TOKEN'));
      await expect(
        credentials.setAgentCredentials(projectId, 'producer', [
          {
            credentialName: 'A',
            delivery: 'environment',
            destination: 'CEREBRA_RUN_TOKEN',
          },
        ]),
      ).rejects.toEqual(new DuplicateDestinationError('CEREBRA_RUN_TOKEN'));
    });
  });

  test('refuses variable names and paths that could not be delivered safely', async () => {
    await withCredentials(async ({ credentials, projectId }) => {
      for (const [delivery, destination] of [
        ['environment', '1ABC'],
        ['environment', 'A-B'],
        ['file', 'relative/path'],
        ['file', '/work/secret'],
        ['file', '/work'],
        ['file', '/run/../work/secret'],
        ['file', '/run/secrets/'],
      ] as const) {
        await expect(
          credentials.setAgentCredentials(projectId, 'producer', [
            { credentialName: 'A', delivery, destination },
          ]),
        ).rejects.toBeInstanceOf(CredentialInputError);
      }
    });
  });

  test('replaces the whole set on save', async () => {
    await withCredentials(async ({ credentials, projectId }) => {
      await credentials.setAgentCredentials(projectId, 'producer', [
        { credentialName: 'A', delivery: 'environment', destination: 'A' },
      ]);
      await credentials.setAgentCredentials(projectId, 'producer', [
        { credentialName: 'B', delivery: 'environment', destination: 'B' },
      ]);

      const declared = (
        await credentials.agentCredentials(projectId, 'producer')
      ).entries.filter((entry) => !entry.builtIn);
      expect(declared.map((entry) => entry.credentialName)).toEqual(['B']);
    });
  });
});

describe('resolving credentials for a run', { concurrent: false }, () => {
  test('gives a run only its permitted credentials, project scope first', async () => {
    await withCredentials(async ({ credentials, database, projectId }) => {
      await saveModelAndGitHub(credentials, projectId);
      await credentials.save({
        name: agentGitHubCredentialName,
        scope: 'instance',
        value: 'ghp-instance',
      });
      await credentials.save({
        name: 'Deploy key',
        scope: 'instance',
        value: 'deploy',
      });
      await credentials.save({
        name: 'Unrelated',
        scope: 'instance',
        value: 'unrelated',
      });
      await credentials.setAgentCredentials(projectId, 'producer', [
        {
          credentialName: 'Deploy key',
          delivery: 'file',
          destination: '/run/secrets/deploy',
        },
      ]);
      const runId = crypto.randomUUID();

      const result = await credentials.resolveForRun({
        agentType: 'producer',
        projectId,
        runId,
      });

      expect(result).toEqual({
        credentialIds: expect.any(Array),
        environment: {
          CLAUDE_CODE_OAUTH_TOKEN: 'claude-instance',
          GH_TOKEN: 'ghp-agent',
        },
        files: [{ path: '/run/secrets/deploy', value: 'deploy' }],
        ok: true,
      });
      const used = await database
        .selectFrom('credentials')
        .select(['name', 'last_used_run_id', 'last_used_at'])
        .where('last_used_at', 'is not', null)
        .orderBy('name')
        .execute();
      expect(used.map((row) => row.name).sort()).toEqual([
        'Claude sign-in token',
        'Deploy key',
        'GitHub access token',
      ]);
      expect(used.every((row) => row.last_used_run_id === runId)).toBe(true);
      const overview = await credentials.overview(projectId);
      expect(
        overview.instanceCredentials.find(
          (row) => row.name === modelCredentialName,
        )?.lastUsedAt,
      ).toEqual(expect.any(String));
    });
  });

  test('gives the agent GitHub token only to the types that push', async () => {
    await withCredentials(async ({ credentials, projectId }) => {
      await saveModelAndGitHub(credentials, projectId);

      for (const agentType of ['producer', 'bugfixer', 'assistant']) {
        const result = await credentials.resolveForRun({
          agentType,
          projectId,
          runId: crypto.randomUUID(),
        });
        expect(result.ok && result.environment.GH_TOKEN).toBe('ghp-agent');
      }
      for (const agentType of ['groomer', 'designer', 'reviewer']) {
        const result = await credentials.resolveForRun({
          agentType,
          projectId,
          runId: crypto.randomUUID(),
        });
        expect(result).toEqual({
          credentialIds: expect.any(Array),
          environment: { CLAUDE_CODE_OAUTH_TOKEN: 'claude-instance' },
          files: [],
          ok: true,
        });
      }
    });
  });

  test('never gives a run the backend project token', async () => {
    await withCredentials(async ({ credentials, database, projectId }) => {
      await saveModelAndGitHub(credentials, projectId);
      await database
        .updateTable('projects')
        .set({
          github_token_ciphertext: 'backend-only',
          github_token_iv: 'backend-only',
          github_token_tag: 'backend-only',
        })
        .where('id', '=', projectId)
        .execute();

      const result = await credentials.resolveForRun({
        agentType: 'producer',
        projectId,
        runId: crypto.randomUUID(),
      });

      expect(JSON.stringify(result)).not.toContain('backend-only');
    });
  });

  test('reports a missing credential and starts nothing', async () => {
    await withCredentials(async ({ credentials, projectId }) => {
      await credentials.save({
        name: modelCredentialName,
        scope: 'instance',
        value: 'claude',
      });
      await credentials.setAgentCredentials(projectId, 'reviewer', [
        {
          credentialName: 'Deploy key',
          delivery: 'environment',
          destination: 'DEPLOY',
        },
      ]);

      expect(
        await credentials.resolveForRun({
          agentType: 'reviewer',
          projectId,
          runId: crypto.randomUUID(),
        }),
      ).toEqual({
        ok: false,
        problems: [{ name: 'Deploy key', reason: 'missing' }],
      });
    });
  });

  test('names what a run would be refused for, without opening anything', async () => {
    await withCredentials(async ({ credentials, database, projectId }) => {
      expect(
        await credentials.problemsFor({ agentType: 'producer', projectId }),
      ).toEqual([modelCredentialName, agentGitHubCredentialName]);

      await saveModelAndGitHub(credentials, projectId);
      await database
        .updateTable('credentials')
        .set({ value_tag: Buffer.alloc(16).toString('base64') })
        .execute();

      expect(
        await credentials.problemsFor({ agentType: 'producer', projectId }),
      ).toEqual([]);
      await database
        .updateTable('credentials')
        .set({ problem: 'injection_failed' })
        .where('name', '=', agentGitHubCredentialName)
        .execute();
      expect(
        await credentials.problemsFor({ agentType: 'producer', projectId }),
      ).toEqual([agentGitHubCredentialName]);
      expect(
        await credentials.problemsFor({ agentType: 'reviewer', projectId }),
      ).toEqual([]);
      expect(
        await database
          .selectFrom('credentials')
          .select('name')
          .where('last_used_at', 'is not', null)
          .execute(),
      ).toEqual([]);
    });
  });

  test('marks a credential it cannot decrypt, until it is replaced', async () => {
    await withCredentials(async ({ credentials, database, projectId }) => {
      await saveModelAndGitHub(credentials, projectId);
      await database
        .updateTable('credentials')
        .set({ value_tag: Buffer.alloc(16).toString('base64') })
        .where('name', '=', agentGitHubCredentialName)
        .execute();
      const request = {
        agentType: 'producer',
        projectId,
        runId: crypto.randomUUID(),
      };

      expect(await credentials.resolveForRun(request)).toEqual({
        ok: false,
        problems: [
          { name: agentGitHubCredentialName, reason: 'undecryptable' },
        ],
      });
      const overview = await credentials.overview(projectId);
      expect(overview.attention).toEqual([
        {
          agentTypes: ['assistant', 'bugfixer', 'producer'],
          everyAgent: false,
          name: agentGitHubCredentialName,
          scope: 'project',
        },
      ]);
      expect(
        overview.projectCredentials.find(
          (row) => row.name === agentGitHubCredentialName,
        )?.needsAttention,
      ).toBe(true);
      expect(
        (
          await credentials.agentCredentials(projectId, 'producer')
        ).entries.find(
          (entry) => entry.credentialName === agentGitHubCredentialName,
        )?.needsAttention,
      ).toBe(true);

      await credentials.save({
        name: agentGitHubCredentialName,
        projectId,
        scope: 'project',
        value: 'ghp-new',
      });

      expect((await credentials.overview(projectId)).attention).toEqual([]);
      expect((await credentials.resolveForRun(request)).ok).toBe(true);
    });
  });

  test('refuses a credential whose injection failed, until it is replaced', async () => {
    await withCredentials(async ({ credentials, projectId }) => {
      await saveModelAndGitHub(credentials, projectId);
      const first = await credentials.resolveForRun({
        agentType: 'reviewer',
        projectId,
        runId: crypto.randomUUID(),
      });
      if (!first.ok) {
        throw new Error('expected the first run to resolve');
      }

      await credentials.recordInjectionFailure(first.credentialIds[0]!);

      expect(
        await credentials.resolveForRun({
          agentType: 'reviewer',
          projectId,
          runId: crypto.randomUUID(),
        }),
      ).toEqual({
        ok: false,
        problems: [{ name: modelCredentialName, reason: 'injection_failed' }],
      });
      await expect(
        credentials.recordInjectionFailure(crypto.randomUUID()),
      ).rejects.toBeInstanceOf(CredentialNotFoundError);
    });
  });
});

describe('credentials needing attention', { concurrent: false }, () => {
  test('shows a credential an agent needs but nobody saved', async () => {
    await withCredentials(async ({ credentials, projectId }) => {
      await saveModelAndGitHub(credentials, projectId);
      await credentials.setAgentCredentials(projectId, 'reviewer', [
        {
          credentialName: 'Deploy key',
          delivery: 'environment',
          destination: 'DEPLOY',
        },
      ]);

      const overview = await credentials.overview(projectId);

      expect(overview.attention).toEqual([
        {
          agentTypes: ['reviewer'],
          everyAgent: false,
          name: 'Deploy key',
          scope: null,
        },
      ]);
      expect(
        overview.projectCredentials.find((row) => row.name === 'Deploy key'),
      ).toEqual({
        id: null,
        lastUsedAt: null,
        lastUsedRunId: null,
        name: 'Deploy key',
        needsAttention: true,
        scope: 'project',
        usedBy: ['reviewer'],
        usedByEveryAgent: false,
      });
    });
  });

  test('asks for the model and GitHub credentials before anything can start', async () => {
    await withCredentials(async ({ credentials, projectId }) => {
      const overview = await credentials.overview(projectId);

      expect(overview.attention).toEqual([
        {
          agentTypes: [],
          everyAgent: true,
          name: modelCredentialName,
          scope: null,
        },
        {
          agentTypes: ['assistant', 'bugfixer', 'producer'],
          everyAgent: false,
          name: agentGitHubCredentialName,
          scope: null,
        },
      ]);
      expect(overview.instanceCredentials.map((row) => row.name)).toEqual([
        modelCredentialName,
      ]);
      expect(overview.projectCredentials.map((row) => row.name)).toEqual([
        agentGitHubCredentialName,
      ]);
    });
  });

  test('says which agent types use each credential', async () => {
    await withCredentials(async ({ credentials, projectId }) => {
      await saveModelAndGitHub(credentials, projectId);
      await credentials.save({
        name: agentGitHubCredentialName,
        scope: 'instance',
        value: 'fallback',
      });
      await credentials.save({ name: 'Idle', scope: 'instance', value: 'x' });

      const overview = await credentials.overview(projectId);

      expect(
        overview.projectCredentials.find(
          (row) => row.name === agentGitHubCredentialName,
        )?.usedBy,
      ).toEqual(['assistant', 'bugfixer', 'producer']);
      expect(
        overview.instanceCredentials.find(
          (row) => row.name === agentGitHubCredentialName,
        )?.usedBy,
      ).toEqual([]);
      expect(
        overview.instanceCredentials.find(
          (row) => row.name === modelCredentialName,
        )?.usedByEveryAgent,
      ).toBe(true);
      expect(
        overview.instanceCredentials.find((row) => row.name === 'Idle')?.usedBy,
      ).toEqual([]);
    });
  });

  test('lists every-project credentials without a project in context', async () => {
    await withCredentials(async ({ credentials }) => {
      await credentials.save({
        name: modelCredentialName,
        scope: 'instance',
        value: 'x',
      });

      const overview = await credentials.overview();

      expect(overview.project).toBeNull();
      expect(overview.projectCredentials).toEqual([]);
      expect(overview.instanceCredentials.map((row) => row.name)).toEqual([
        modelCredentialName,
        agentGitHubCredentialName,
      ]);
      expect(overview.attention.map((entry) => entry.name)).toEqual([
        agentGitHubCredentialName,
      ]);
    });
  });
});
