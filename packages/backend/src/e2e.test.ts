// @vitest-environment node
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { sql, type Kysely } from 'kysely';
import { describe, expect, test } from 'vitest';

import { createBackend, type Backend } from './backend.js';
import { createBoard } from './board.js';
import { createRunCheckouts, type RunCheckouts } from './checkouts.js';
import { createEnvelopeCipher } from './credential-cipher.js';
import {
  agentGitHubCredentialName,
  createCredentialService,
  modelCredentialName,
} from './credentials.js';
import type { Database } from './database.js';
import type { Forge, ForgeChecks, ForgeReview, ProjectForge } from './forge.js';
import { createPodmanEngine } from './podman-engine.js';
import { directoryPreparer } from './supervisor.js';
import {
  registerTestProject,
  testMasterKey,
  withTestDatabase,
} from './test-support.js';

/*
 * The loop of roadmap step 7 under real rootless Podman (architecture §13): the real backend and
 * supervisor start the stub agent image, whose runner replays the script committed in the
 * project's repository instead of calling a model. GitHub is the one fake: a local repository
 * served by `git daemon`, and a forge that reads it. Run it with `pnpm run test:e2e`.
 */
const podmanSocket = process.env.CEREBRA_TEST_PODMAN_SOCKET ?? '';
const required = process.env.CEREBRA_REQUIRE_PODMAN === '1';
/** Only `pnpm run test:e2e` builds the stub image, so only it turns this suite on. */
const enabled = process.env.CEREBRA_E2E === '1';
const stubImage = process.env.CEREBRA_E2E_IMAGE ?? 'cerebra-stub-agent';
/** How a container reaches a port the test listens on, on the machine running the test. */
const containerHost =
  process.env.CEREBRA_E2E_CONTAINER_HOST ?? 'host.containers.internal';
const loopTimeout = 300_000;
const scriptFile = '.cerebra-stub.json';

test.runIf(enabled && required && podmanSocket === '')(
  'the real-Podman suite is required but has no Podman socket',
  () => {
    throw new Error(
      'CEREBRA_REQUIRE_PODMAN=1 needs CEREBRA_TEST_PODMAN_SOCKET, the rootless Podman API socket.',
    );
  },
);

function run(command: string, args: readonly string[], cwd?: string): string {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed: ${result.stderr || result.error?.message}`,
    );
  }
  return result.stdout.trim();
}

const git = (cwd: string, ...args: string[]) => run('git', args, cwd);
const bare = (repository: string, ...args: string[]) =>
  run('git', ['--git-dir', repository, ...args]);

async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve));
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  if (address === null || typeof address === 'string') {
    throw new Error('No free port');
  }
  return address.port;
}

async function until<T>(
  what: string,
  check: () => Promise<T | undefined>,
  diagnose: () => Promise<string>,
  timeoutMs = 120_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${what}.\n${await diagnose()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

type Step =
  | { readonly say: string }
  | { readonly run: readonly string[]; readonly as?: string }
  | { readonly tool: string; readonly arguments?: unknown };

const gitAs = [
  'git',
  '-c',
  'safe.directory=*',
  '-c',
  'user.name=Stub',
  '-c',
  'user.email=stub@example.invalid',
];

const plan = [
  'Context',
  'Files to change, and what to reuse',
  'Increments',
  'The test plan',
  'User-facing decisions',
  'Out of scope',
  'Validation',
  'Known traps',
]
  .map((heading) => `## ${heading}\n\nNone: the stub has nothing to plan.\n`)
  .join('\n');

/** One build: commit a line, push the item's branch, and hand the pull request to review. */
function build(remote: string, pullRequest: string, line: string): Step[] {
  return [
    { run: [...gitAs, 'switch', '-C', '{{key}}'] },
    { run: ['sh', '-c', `echo ${line} >> feature.txt`] },
    { run: [...gitAs, 'add', 'feature.txt'] },
    { run: [...gitAs, 'commit', '-m', `Write ${line}`] },
    { run: [...gitAs, 'push', remote, 'HEAD:refs/heads/{{key}}'] },
    { run: [...gitAs, 'rev-parse', 'HEAD'], as: 'head' },
    {
      tool: 'report_checks',
      arguments: { passed: true, summary: 'The stub ran no checks.' },
    },
    {
      tool: 'transition',
      arguments: {
        to: 'review_ready',
        record: {
          kind: 'pull_request',
          branch: '{{key}}',
          head: '{{head}}',
          title: 'Write the feature',
          url: pullRequest,
        },
      },
    },
  ];
}

function review(
  pullRequest: string,
  verdict: 'approved' | 'changes_requested',
): Step[] {
  return [
    { run: [...gitAs, 'rev-parse', 'HEAD'], as: 'head' },
    {
      tool: 'transition',
      arguments: {
        to: verdict === 'approved' ? 'merging' : 'build_ready',
        record: {
          kind: 'review',
          verdict,
          revision: '{{head}}',
          url: `${pullRequest}#pullrequestreview-1`,
          findings:
            verdict === 'approved'
              ? []
              : [
                  {
                    severity: 'blocking',
                    file: 'feature.txt',
                    line: 1,
                    problem: 'Write a second line.',
                  },
                ],
        },
      },
    },
  ];
}

/** The fake GitHub: pull requests are branches of the local remote, merged by moving `main`. */
interface FakeGitHub {
  readonly forge: ProjectForge;
  readonly checked: string[];
  /** How many times the loop has read the pull request's reviews. */
  reviewsRead: number;
  checks: Map<string, ForgeChecks>;
  reviews: ForgeReview[];
  readonly merges: { readonly number: number; readonly sha: string }[];
}

function fakeGitHub(remote: string, branchOf: () => string): FakeGitHub {
  const state: FakeGitHub = {
    forge: async () => forge,
    checked: [],
    reviewsRead: 0,
    checks: new Map(),
    reviews: [],
    merges: [],
  };
  const head = (branch: string) =>
    bare(remote, 'rev-parse', `refs/heads/${branch}`);
  const forge: Forge = {
    async checks(sha) {
      state.checked.push(sha);
      return state.checks.get(sha) ?? { status: 'pending' };
    },
    async closePullRequest(number) {
      throw new Error(`The loop closed pull request ${number}.`);
    },
    async deleteBranch(branch) {
      bare(remote, 'update-ref', '-d', `refs/heads/${branch}`);
    },
    async merge(number, sha) {
      if (head(branchOf()) !== sha) {
        return { merged: false, reason: 'head_moved' };
      }
      bare(remote, 'update-ref', 'refs/heads/main', sha);
      state.merges.push({ number, sha });
      return { merged: true };
    },
    async pullRequest() {
      const merged = state.merges.at(-1);
      return merged === undefined
        ? {
            branch: branchOf(),
            head: head(branchOf()),
            mergeable: true,
            state: 'open',
          }
        : {
            branch: branchOf(),
            head: merged.sha,
            mergeable: true,
            state: 'merged',
          };
    },
    async reviewComments() {
      return [];
    },
    async reviews() {
      state.reviewsRead += 1;
      return state.reviews;
    },
  };
  return state;
}

interface Loop {
  readonly database: Kysely<Database>;
  readonly backend: Backend;
  readonly github: FakeGitHub;
  readonly itemId: string;
  readonly projectId: string;
  readonly remote: string;
  readonly logs: string[];
  diagnose(): Promise<string>;
}

interface Resources {
  directory?: string;
  daemon?: ChildProcess;
  server?: FastifyInstance;
  volume?: string;
  networks: string[];
  runIds: string[];
}

let resources: Resources = { networks: [], runIds: [] };

async function teardown(): Promise<void> {
  const { server, daemon, volume, networks, directory, runIds } = resources;
  resources = { networks: [], runIds: [] };
  // A runner still waiting on the backend would hold the server open.
  for (const runId of runIds) {
    spawnSync('podman', [
      'rm',
      '--force',
      '--time',
      '0',
      `cerebra-run-${runId}`,
    ]);
  }
  server?.server.closeAllConnections();
  await server?.close();
  daemon?.kill();
  if (volume !== undefined)
    spawnSync('podman', ['volume', 'rm', '--force', volume]);
  if (networks.length > 0) {
    spawnSync('podman', ['network', 'rm', '--force', ...networks]);
  }
  if (directory !== undefined) {
    // What an agent wrote belongs to its container's user; only Podman's namespace may remove it.
    await rm(directory, { recursive: true, force: true }).catch(() => {
      // A cleanup failure must not hide the test's own.
      const removed = spawnSync('podman', ['unshare', 'rm', '-rf', directory], {
        encoding: 'utf8',
      });
      if (removed.status !== 0) {
        console.error(`Could not remove ${directory}: ${removed.stderr}`);
      }
    });
  }
}

/** Runs `body` against a started loop, in a database of its own, and tears both down. */
async function withLoop(
  options: Parameters<typeof startLoop>[1],
  body: (loop: Loop) => Promise<void>,
): Promise<void> {
  await withTestDatabase(async (database) => {
    try {
      await body(await startLoop(database, options));
    } finally {
      await teardown();
    }
  });
}

/** Everything under `path` open to the agent's uid, which is not the test's. */
function openToAgents(path: string): void {
  run('chmod', ['-R', 'a+rwX', path]);
}

async function startLoop(
  database: Kysely<Database>,
  options: {
    readonly name: string;
    readonly script: (remote: string, pullRequest: string) => unknown;
    readonly involvement?: 'full';
  },
): Promise<Loop> {
  const suffix = randomUUID().slice(0, 8);
  const directory = await mkdtemp(join(tmpdir(), 'cerebra-e2e-'));
  resources.directory = directory;
  const dataDirectory = join(directory, 'data');
  const served = join(directory, 'served');
  const remote = join(served, `${options.name}.git`);
  await mkdir(dataDirectory, { recursive: true });
  openToAgents(dataDirectory);

  const gitPort = await freePort();
  const containerRemote = `git://${containerHost}:${gitPort}/${options.name}.git`;
  const pullRequest = `https://github.com/acme/${options.name}/pull/1`;

  // The project's repository, with the stub's script on its default branch.
  const seed = join(directory, 'seed');
  await mkdir(seed);
  git(seed, 'init', '--quiet', '--initial-branch=main');
  await writeFile(join(seed, 'README.md'), '# Fixture\n');
  await writeFile(
    join(seed, scriptFile),
    `${JSON.stringify(options.script(containerRemote, pullRequest), null, 2)}\n`,
  );
  git(seed, 'add', '.');
  git(
    seed,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'Fixture',
  );
  await mkdir(served);
  run('git', ['clone', '--quiet', '--bare', seed, remote]);

  const daemon = spawn(
    'git',
    [
      'daemon',
      '--reuseaddr',
      '--export-all',
      '--enable=receive-pack',
      `--base-path=${served}`,
      '--listen=0.0.0.0',
      `--port=${gitPort}`,
      served,
    ],
    { stdio: 'ignore' },
  );
  resources.daemon = daemon;
  const hostRemote = `git://127.0.0.1:${gitPort}/${options.name}.git`;
  await until(
    'git daemon',
    async () =>
      spawnSync('git', ['ls-remote', hostRemote]).status === 0
        ? true
        : undefined,
    async () => 'git daemon never answered.',
    20_000,
  );

  const internalNetwork = `cerebra-e2e-internal-${suffix}`;
  const egressNetwork = `cerebra-e2e-egress-${suffix}`;
  const dataVolume = `cerebra-e2e-data-${suffix}`;
  run('podman', ['network', 'create', '--internal', internalNetwork]);
  resources.networks.push(internalNetwork);
  run('podman', ['network', 'create', egressNetwork]);
  resources.networks.push(egressNetwork);
  run('podman', [
    'volume',
    'create',
    '--opt',
    'type=none',
    '--opt',
    'o=bind',
    '--opt',
    `device=${dataDirectory}`,
    dataVolume,
  ]);
  resources.volume = dataVolume;

  const projectId = await registerTestProject(database, options.name);
  if (options.involvement === 'full') {
    await database
      .updateTable('projects')
      .set({ involvement: 'full', review_account: 'navigator' })
      .where('id', '=', projectId)
      .execute();
  }
  const credentials = createCredentialService({
    cipher: createEnvelopeCipher(testMasterKey),
    database,
  });
  // The stub reads neither; the dispatcher starts nothing without them.
  await credentials.save({
    name: modelCredentialName,
    scope: 'instance',
    value: 'stub-model-token',
  });
  await credentials.save({
    name: agentGitHubCredentialName,
    scope: 'instance',
    value: 'stub-github-token',
  });

  const board = createBoard(database);
  const itemId = randomUUID();
  const github = fakeGitHub(remote, () => itemKey);
  let itemKey = '';

  const real = createRunCheckouts({
    dataDirectory,
    project: async () => ({
      remote: hostRemote,
      defaultBranch: 'main',
      credential: '',
    }),
  });
  const checkouts: RunCheckouts = {
    ...real,
    async create(input) {
      resources.runIds.push(input.runId);
      await real.create(input);
      openToAgents(join(dataDirectory, 'runs', input.runId));
    },
  };
  const prepare = directoryPreparer(dataDirectory);
  const logs: string[] = [];
  const port = await freePort();
  const backend = await createBackend({
    backupConfig: undefined,
    checkouts,
    database,
    databaseUrl: '',
    dataDirectory,
    dispatchEveryMs: 500,
    engine: createPodmanEngine({
      dataVolume,
      egressNetwork,
      internalNetwork,
      socketPath: podmanSocket,
    }),
    forge: github.forge,
    gatewayUrl: `ws://${containerHost}:${port}/runner`,
    log: (message) => logs.push(message),
    masterKey: testMasterKey,
    mcpUrl: `http://${containerHost}:${port}/mcp`,
    mergeEveryMs: 500,
    async prepareDirectories(runId, agentId) {
      await prepare(runId, agentId);
      openToAgents(join(dataDirectory, 'agents', agentId));
    },
    uiDirectory: directory,
  });
  resources.server = backend.server;
  await backend.server.listen({ host: '0.0.0.0', port });
  // Seeding at start rewrote the agent types; every type now runs the stub.
  await database
    .updateTable('agent_types')
    .set({
      definition: sql`definition || ${JSON.stringify({ image: stubImage })}::jsonb`,
    })
    .execute();

  await board.createWorkItem({
    id: itemId,
    projectId,
    title: 'Write the feature',
  });
  itemKey = (await board.getWorkItem(itemId)).key;
  // Filed and ranked by the navigator; nothing below starts a run.
  await board.triage(itemId, 'P2', 'build_ready');

  return {
    backend,
    database,
    github,
    itemId,
    logs,
    projectId,
    remote,
    async diagnose() {
      const [item, runs, history] = await Promise.all([
        board.getWorkItem(itemId),
        database
          .selectFrom('runs')
          .select(['id', 'role', 'status', 'failure', 'agent_name'])
          .where('project_id', '=', projectId)
          .orderBy('created_at')
          .execute(),
        board.getHistory(itemId),
      ]);
      return JSON.stringify(
        {
          state: item.state,
          history: history.map(
            (entry) => `${entry.fromState}→${entry.toState}`,
          ),
          runs: runs.map((entry) => ({
            ...entry,
            container: spawnSync('podman', [
              'logs',
              '--tail',
              '40',
              `cerebra-run-${entry.id}`,
            ])
              .output.join('')
              .trim(),
          })),
          logs,
        },
        null,
        2,
      );
    },
  };
}

async function stateOf(loop: Loop): Promise<string> {
  return (await createBoard(loop.database).getWorkItem(loop.itemId)).state;
}

const reached = (loop: Loop, state: string) => async () =>
  (await stateOf(loop)) === state ? true : undefined;

async function recordsOf(
  loop: Loop,
  kind: string,
): Promise<Record<string, unknown>[]> {
  const rows = await loop.database
    .selectFrom('work_item_records')
    .select(['id', 'payload'])
    .where('work_item_id', '=', loop.itemId)
    .where('kind', '=', kind)
    .orderBy('id')
    .execute();
  return rows.map((row) => ({ id: row.id, ...(row.payload as object) }));
}

/** Waits while the merge watcher looks at `head`'s checks, and returns once it has twice. */
async function watchedTwice(loop: Loop, head: string): Promise<void> {
  const before = loop.github.checked.filter((sha) => sha === head).length;
  await until(
    'the merge watcher to read the pending checks',
    async () =>
      loop.github.checked.filter((sha) => sha === head).length >= before + 2
        ? true
        : undefined,
    () => loop.diagnose(),
  );
}

describe.skipIf(!enabled || podmanSocket === '')(
  'the loop under real Podman',
  () => {
    test(
      'an item in build_ready is built, sent back once, reworked on the same pull request, and merged only once approved and green',
      async () => {
        await withLoop(
          {
            name: 'website',
            script: (remote, pullRequest) => ({
              building: [
                [
                  { say: 'Building {{key}}.' },
                  { tool: 'submit_plan', arguments: { markdown: plan } },
                  ...build(remote, pullRequest, 'first'),
                ],
                [
                  { say: 'Reworking {{key}}.' },
                  { tool: 'submit_plan', arguments: { markdown: plan } },
                  ...build(remote, pullRequest, 'second'),
                ],
              ],
              reviewing: [
                review(pullRequest, 'changes_requested'),
                review(pullRequest, 'approved'),
              ],
            }),
          },
          async (loop) => {
            await until('merging', reached(loop, 'merging'), () =>
              loop.diagnose(),
            );
            // The script names the one pull request both times; that the rework reused its branch
            // is proven below, by main holding both builds' lines.
            const pullRequests = await recordsOf(loop, 'pull_request');
            expect(pullRequests.map((record) => record.url)).toEqual([
              'https://github.com/acme/website/pull/1',
              'https://github.com/acme/website/pull/1',
            ]);
            const approved = String(pullRequests[1]?.head);
            expect(approved).not.toBe(pullRequests[0]?.head);
            const reviews = await recordsOf(loop, 'review');
            expect(reviews.map((record) => record.verdict)).toEqual([
              'changes_requested',
              'approved',
            ]);
            expect(reviews[1]?.revision).toBe(approved);

            // Approved, but its checks are still running: nothing merges.
            await watchedTwice(loop, approved);
            expect(await stateOf(loop)).toBe('merging');
            expect(loop.github.merges).toEqual([]);

            loop.github.checks.set(approved, { status: 'success' });
            await until('done', reached(loop, 'done'), () => loop.diagnose());

            expect(loop.github.merges).toEqual([{ number: 1, sha: approved }]);
            expect(bare(loop.remote, 'rev-parse', 'refs/heads/main')).toBe(
              approved,
            );
            expect(
              bare(loop.remote, 'show', 'main:feature.txt').split('\n'),
            ).toEqual(['first', 'second']);
            const history = await createBoard(loop.database).getHistory(
              loop.itemId,
            );
            expect(history.map((entry) => entry.toState)).toEqual([
              'build_ready',
              'building',
              'review_ready',
              'reviewing',
              'build_ready',
              'building',
              'review_ready',
              'reviewing',
              'merging',
              'done',
            ]);
            const runs = await loop.database
              .selectFrom('runs')
              .select(['role', 'status', 'container_id'])
              .where('work_item_id', '=', loop.itemId)
              .orderBy('created_at')
              .execute();
            expect(runs.map((entry) => [entry.role, entry.status])).toEqual([
              ['builder', 'finished'],
              ['reviewer', 'finished'],
              ['builder', 'finished'],
              ['reviewer', 'finished'],
            ]);
            expect(runs.every((entry) => entry.container_id !== null)).toBe(
              true,
            );
            await until(
              'every run container to be removed',
              async () =>
                runs.every(
                  (entry) =>
                    spawnSync('podman', [
                      'container',
                      'exists',
                      entry.container_id ?? '',
                    ]).status === 1,
                )
                  ? true
                  : undefined,
              () => loop.diagnose(),
              30_000,
            );
          },
        );
      },
      loopTimeout,
    );

    test(
      'with involvement full, the item stops at the plan and at the code review before it merges',
      async () => {
        await withLoop(
          {
            name: 'webshop',
            involvement: 'full',
            script: (remote, pullRequest) => ({
              building: [
                [
                  { tool: 'submit_plan', arguments: { markdown: plan } },
                  ...build(remote, pullRequest, 'only'),
                ],
              ],
              reviewing: [review(pullRequest, 'approved')],
            }),
          },
          async (loop) => {
            // The builder waits in submit_plan for the navigator's answer.
            const plans = await until(
              'the plan to wait for the navigator',
              async () => {
                const found = await recordsOf(loop, 'plan');
                return found.length > 0 ? found : undefined;
              },
              () => loop.diagnose(),
            );
            // A plan that needs approval holds submit_plan open, so the builder can go no further.
            expect(plans.map((record) => record.approval)).toEqual([
              'required',
            ]);
            const holder = await loop.database
              .selectFrom('work_items')
              .innerJoin('runs', 'runs.id', 'work_items.holder_run_id')
              .select(['runs.id', 'runs.role', 'runs.status'])
              .where('work_items.id', '=', loop.itemId)
              .executeTakeFirstOrThrow();
            expect(holder.role).toBe('builder');
            expect(['active', 'awaiting_input']).toContain(holder.status);
            expect(await stateOf(loop)).toBe('building');
            expect(await recordsOf(loop, 'pull_request')).toEqual([]);

            await loop.backend.plans?.answer(holder.id, {
              planId: Number(plans[0]?.id),
              verdict: 'approved',
            });

            // Approved by the reviewer, the item waits for the navigator's review on GitHub.
            const waiting = await until(
              'the code review checkpoint',
              async () => {
                const found = await recordsOf(loop, 'awaiting_code_review');
                return (await stateOf(loop)) === 'waiting' && found.length > 0
                  ? found
                  : undefined;
              },
              () => loop.diagnose(),
            );
            const head = String(
              (await recordsOf(loop, 'pull_request'))[0]?.head,
            );
            loop.github.checks.set(head, { status: 'success' });
            // Green, but without the navigator's review: watch the backend read the reviews twice.
            const read = loop.github.reviewsRead;
            await until(
              'the backend to read the reviews again',
              async () =>
                loop.github.reviewsRead >= read + 2 ? true : undefined,
              () => loop.diagnose(),
            );
            expect(await stateOf(loop)).toBe('waiting');
            expect(loop.github.merges).toEqual([]);
            expect(waiting[0]?.account).toBe('navigator');

            loop.github.reviews = [
              {
                body: 'Looks right.',
                id: 7,
                login: 'navigator',
                state: 'approved',
                submittedAt: new Date(),
                url: 'https://github.com/acme/webshop/pull/1#pullrequestreview-7',
              },
            ];
            await until('done', reached(loop, 'done'), () => loop.diagnose());
            expect(loop.github.merges).toEqual([{ number: 1, sha: head }]);
          },
        );
      },
      loopTimeout,
    );
  },
);
