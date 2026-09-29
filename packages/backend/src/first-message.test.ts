import { describe, expect, test } from 'vitest';

import { firstMessage, type FirstMessageInput } from './first-message.js';

const item: FirstMessageInput = {
  description: 'About export.',
  history: [],
  key: 'WEB-1',
  pullRequest: null,
  role: 'builder',
  title: 'Export',
  type: 'feature',
};
const pullRequest = {
  branch: 'WEB-1-export',
  head: '0123456',
  number: 482,
  url: 'https://github.com/acme/website/pull/482',
};

describe('the first message a run is given', () => {
  test('a first build is told only its item', () => {
    expect(firstMessage(item)).toBe('WEB-1 (feature): Export\n\nAbout export.');
  });

  test('a rework continues the same pull request and hears every finding', () => {
    const message = firstMessage({
      ...item,
      history: [
        {
          findings: [
            {
              file: 'src/export.ts',
              line: 4,
              problem: 'The header row is missing.',
              severity: 'blocking',
            },
            { file: 'README.md', problem: 'Typo.', severity: 'advisory' },
          ],
          kind: 'review',
          revision: '0123456',
          verdict: 'changes_requested',
        },
      ],
      pullRequest,
    });

    expect(message).toContain(
      'Continue pull request https://github.com/acme/website/pull/482 on branch WEB-1-export',
    );
    expect(message).toContain(
      'The reviewer requested changes on revision 0123456:\n- Blocking: src/export.ts:4 — The header row is missing.\n- Advisory: README.md — Typo.',
    );
  });

  test('a send-back names the block the navigator answered', () => {
    expect(
      firstMessage({
        ...item,
        history: [
          {
            check: 'test (ubuntu)',
            kind: 'blocked',
            reason: 'check_failed',
            revision: '0123456',
          },
          { kind: 'sent_back' },
        ],
        pullRequest,
      }),
    ).toContain(
      "The navigator sent this back to you after “Can't merge: a required check failed” (test (ubuntu) failed).",
    );
  });

  test('a reviewer is pointed at the pull request', () => {
    expect(firstMessage({ ...item, pullRequest, role: 'reviewer' })).toContain(
      'Review pull request https://github.com/acme/website/pull/482 (branch WEB-1-export).',
    );
  });

  test('after a return to design the reason is given and no pull request is continued', () => {
    const message = firstMessage({
      ...item,
      history: [{ kind: 'returned_to_design', reason: 'New layout.' }],
    });

    expect(message).toContain(
      'The navigator returned this item to design: “New layout.” Its earlier pull request was closed.',
    );
    expect(message).not.toContain('Continue pull request');
  });
});
