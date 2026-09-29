import { describe, expect, test } from 'vitest';

import { createGitHubForge, ForgeError } from './forge.js';

interface Call {
  readonly body: unknown;
  readonly method: string;
  readonly url: string;
  readonly authorization: string | null;
}

function stubFetch(
  answer: (call: Call) => { status: number; body?: unknown },
): { calls: Call[]; fetch: typeof fetch } {
  const calls: Call[] = [];
  return {
    calls,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const call = {
        authorization: headers.get('authorization'),
        body:
          typeof init?.body === 'string'
            ? (JSON.parse(init.body) as unknown)
            : undefined,
        method: init?.method ?? 'GET',
        url: String(input),
      };
      calls.push(call);
      const { body, status } = answer(call);
      return new Response(body === undefined ? null : JSON.stringify(body), {
        status,
      });
    }) as typeof fetch,
  };
}

const repository = {
  remote: 'https://github.com/acme/website.git',
  token: 'project-token',
};
const sha = '0123456789abcdef0123456789abcdef01234567';

describe('the GitHub forge', () => {
  test('reads a pull request’s state, head and mergeability with the project token', async () => {
    const { calls, fetch } = stubFetch(() => ({
      body: {
        head: { ref: 'WEB-1-export', sha },
        mergeable: false,
        merged: false,
        state: 'open',
      },
      status: 200,
    }));
    const forge = createGitHubForge({ ...repository, fetch });

    expect(await forge.pullRequest(482)).toEqual({
      branch: 'WEB-1-export',
      head: sha,
      mergeable: false,
      state: 'open',
    });
    expect(calls[0]).toMatchObject({
      authorization: 'Bearer project-token',
      url: 'https://api.github.com/repos/acme/website/pulls/482',
    });
  });

  test('reports a merged pull request as merged', async () => {
    const { fetch } = stubFetch(() => ({
      body: {
        head: { ref: 'b', sha },
        mergeable: null,
        merged: true,
        state: 'closed',
      },
      status: 200,
    }));

    expect(
      await createGitHubForge({ ...repository, fetch }).pullRequest(1),
    ).toMatchObject({ mergeable: null, state: 'merged' });
  });

  test.each([
    [
      'every check run and status passed',
      [{ conclusion: 'success', name: 'ci', status: 'completed' }],
      [{ context: 'deploy', state: 'success' }],
      { status: 'success' },
    ],
    [
      'a check run failed',
      [
        { conclusion: 'success', name: 'lint', status: 'completed' },
        { conclusion: 'failure', name: 'test (ubuntu)', status: 'completed' },
      ],
      [],
      { check: 'test (ubuntu)', status: 'failure' },
    ],
    [
      'a status errored',
      [{ conclusion: 'skipped', name: 'ci', status: 'completed' }],
      [{ context: 'deploy', state: 'error' }],
      { check: 'deploy', status: 'failure' },
    ],
    [
      'a check is still running',
      [{ conclusion: null, name: 'ci', status: 'in_progress' }],
      [],
      { status: 'pending' },
    ],
    ['nothing has reported at all', [], [], { status: 'none' }],
  ])('checks: %s', async (_name, runs, statuses, expected) => {
    const { fetch } = stubFetch((call) =>
      call.url.includes('/check-runs')
        ? { body: { check_runs: runs }, status: 200 }
        : { body: { statuses }, status: 200 },
    );

    expect(
      await createGitHubForge({ ...repository, fetch }).checks(sha),
    ).toEqual(expected);
  });

  test('merges only the approved revision', async () => {
    const { calls, fetch } = stubFetch((call) =>
      call.url.endsWith('/merge')
        ? { body: { merged: true, sha: 'f00d' }, status: 200 }
        : { status: 204 },
    );
    const forge = createGitHubForge({ ...repository, fetch });

    expect(await forge.merge(482, sha)).toEqual({ merged: true });
    expect(calls[0]).toMatchObject({
      body: { merge_method: 'squash', sha },
      method: 'PUT',
      url: 'https://api.github.com/repos/acme/website/pulls/482/merge',
    });
  });

  test('checks: a failure on a later page is not missed', async () => {
    const passing = Array.from({ length: 100 }, (_, index) => ({
      conclusion: 'success',
      name: `job ${index}`,
      status: 'completed',
    }));
    const { calls, fetch } = stubFetch((call) =>
      call.url.includes('/check-runs')
        ? call.url.includes('page=2')
          ? {
              body: {
                check_runs: [
                  { conclusion: 'failure', name: 'late', status: 'completed' },
                ],
                total_count: 101,
              },
              status: 200,
            }
          : { body: { check_runs: passing, total_count: 101 }, status: 200 }
        : { body: { statuses: [], total_count: 0 }, status: 200 },
    );

    expect(
      await createGitHubForge({ ...repository, fetch }).checks(sha),
    ).toEqual({ check: 'late', status: 'failure' });
    expect(
      calls.filter((call) => call.url.includes('/check-runs')),
    ).toHaveLength(2);
  });

  test('a merge whose head moved says so', async () => {
    const { fetch } = stubFetch(() => ({ body: {}, status: 409 }));

    expect(
      await createGitHubForge({ ...repository, fetch }).merge(1, sha),
    ).toEqual({ merged: false, reason: 'head_moved' });
  });

  test('a merge GitHub refuses carries GitHub’s own words', async () => {
    const { fetch } = stubFetch(() => ({
      body: { message: 'At least 1 approving review is required.' },
      status: 405,
    }));

    expect(
      await createGitHubForge({ ...repository, fetch }).merge(1, sha),
    ).toEqual({
      merged: false,
      message: 'At least 1 approving review is required.',
      reason: 'refused',
    });
  });

  test('deletes a branch, treating one already gone as deleted', async () => {
    const { calls, fetch } = stubFetch(() => ({ status: 422 }));

    await createGitHubForge({ ...repository, fetch }).deleteBranch(
      'WEB-1-export',
    );
    expect(calls[0]).toMatchObject({
      method: 'DELETE',
      url: 'https://api.github.com/repos/acme/website/git/refs/heads/WEB-1-export',
    });
  });

  test('closes a pull request with a comment', async () => {
    const { calls, fetch } = stubFetch(() => ({ body: {}, status: 200 }));

    await createGitHubForge({ ...repository, fetch }).closePullRequest(
      482,
      'Returned to design: new layout.',
    );
    expect(calls.map((call) => [call.method, call.url, call.body])).toEqual([
      [
        'POST',
        'https://api.github.com/repos/acme/website/issues/482/comments',
        { body: 'Returned to design: new layout.' },
      ],
      [
        'PATCH',
        'https://api.github.com/repos/acme/website/pulls/482',
        { state: 'closed' },
      ],
    ]);
  });

  test('a failed read is an error, never an empty answer', async () => {
    const { fetch } = stubFetch(() => ({ body: {}, status: 502 }));
    const forge = createGitHubForge({ ...repository, fetch });

    await expect(forge.pullRequest(1)).rejects.toBeInstanceOf(ForgeError);
    await expect(forge.checks(sha)).rejects.toBeInstanceOf(ForgeError);
  });
});
