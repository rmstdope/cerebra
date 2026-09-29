import { expect, test } from 'vitest';
import { gitErrorMessage, redactGitError } from './git-errors.js';

test('redacts raw, URL-encoded and base64 credentials and authorization headers', () => {
  const credential = 'synthetic:token/with+characters';
  const basic = Buffer.from(`x-access-token:${credential}`).toString('base64');
  const output = [
    `fatal: ${credential}`,
    encodeURIComponent(credential),
    Buffer.from(credential).toString('base64'),
    basic,
    `Authorization: Basic ${basic}`,
    'authorization: Bearer unrelated-secret',
    'https://someone:another-secret@github.com/owner/repo.git',
    'fatal: Authentication failed',
  ].join('\n');
  const safe = redactGitError(output, credential);
  for (const secret of [
    credential,
    encodeURIComponent(credential),
    basic,
    Buffer.from(credential).toString('base64'),
    'unrelated-secret',
    'another-secret',
  ]) {
    expect(safe).not.toContain(secret);
  }
  expect(safe).toContain('Authentication failed');
});

test.each([
  ['fatal: Authentication failed', /token.*read.*contents/i],
  ['remote: Repository not found.', /repository.*access/i],
  ['fatal: Could not resolve host: github.com', /network.*DNS/i],
  [
    'fatal: SSL certificate problem: unable to get local issuer certificate',
    /certificate/i,
  ],
  ['fatal: No space left on device', /Free space/i],
  ['fatal: Permission denied', /storage permissions/i],
  ['fatal: destination path already exists', /already exists/i],
  ['remote: organization requires SAML SSO', /SSO/i],
  ['remote: unexpected server failure', /unexpected server failure/],
])('explains Git failure %s', (stderr, expected) => {
  expect(gitErrorMessage(stderr)).toMatch(expected);
});

test('empty diagnostic directs the user to the container log', () => {
  expect(gitErrorMessage('')).toMatch(/logs/i);
});

test('removes terminal control sequences before redacting credentials', () => {
  expect(
    redactGitError(
      'fatal: synthetic-\u001b[31mtoken\u001b[0m',
      'synthetic-token',
    ),
  ).toBe('fatal: [redacted]');
});
