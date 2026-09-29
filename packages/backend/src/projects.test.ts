import { describe, expect, test } from 'vitest';

import {
  InvalidProjectUrlError,
  ProjectRegistrationService,
  type GitHubRepository,
  type MirrorRepository,
  type ProjectStore,
} from './projects.js';

const repository: GitHubRepository = {
  discover: async () => ({
    defaultBranch: 'main',
    name: 'website',
    remote: 'https://github.com/acme/website.git',
    owner: 'acme',
  }),
};

const mirror: MirrorRepository = {
  create: async () => undefined,
  remove: async () => undefined,
};

function service(
  overrides: {
    repository?: GitHubRepository;
    mirror?: MirrorRepository;
    store?: ProjectStore;
  } = {},
): ProjectRegistrationService {
  return new ProjectRegistrationService({
    mirror: overrides.mirror ?? mirror,
    repository: overrides.repository ?? repository,
    store:
      overrides.store ??
      ({
        create: async ({ project }) => project,
      } satisfies ProjectStore),
  });
}

describe('ProjectRegistrationService', () => {
  test('rejects a repository link outside GitHub before using credentials', async () => {
    await expect(
      service().discover({
        credential: 'secret',
        remote: 'https://gitlab.com/acme/website',
      }),
    ).rejects.toBeInstanceOf(InvalidProjectUrlError);
  });

  test('discovers GitHub metadata and proposes an editable prefix', async () => {
    await expect(
      service().discover({
        credential: 'secret',
        remote: 'https://github.com/acme/website/',
      }),
    ).resolves.toEqual({
      defaultBranch: 'main',
      name: 'website',
      owner: 'acme',
      prefix: 'WEBSITE',
      remote: 'https://github.com/acme/website.git',
    });
  });

  test('creates its mirror before persisting the project', async () => {
    const calls: string[] = [];
    const registration = service({
      mirror: {
        create: async () => calls.push('mirror'),
        remove: async () => calls.push('remove'),
      },
      store: {
        create: async ({ project }) => {
          calls.push('store');
          return project;
        },
      },
    });

    await expect(
      registration.register({
        credential: 'secret',
        prefix: 'WEBSITE',
        remote: 'https://github.com/acme/website',
      }),
    ).resolves.toMatchObject({
      defaultBranch: 'main',
      prefix: 'WEBSITE',
      remote: 'https://github.com/acme/website.git',
    });
    expect(calls).toEqual(['mirror', 'store']);
  });

  test('removes a mirror when durable project creation fails', async () => {
    const calls: string[] = [];
    const registration = service({
      mirror: {
        create: async () => calls.push('mirror'),
        remove: async () => calls.push('remove'),
      },
      store: {
        create: async () => {
          calls.push('store');
          throw new Error('Database unavailable');
        },
      },
    });

    await expect(
      registration.register({
        credential: 'secret',
        prefix: 'WEBSITE',
        remote: 'https://github.com/acme/website',
      }),
    ).rejects.toThrow('Database unavailable');
    expect(calls).toEqual(['mirror', 'store', 'remove']);
  });
});
