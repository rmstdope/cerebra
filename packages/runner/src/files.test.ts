// @vitest-environment node
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { readCheckoutFiles } from './files.js';

let root: string;
let checkout: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cerebra-files-'));
  checkout = join(root, 'work');
  await mkdir(join(checkout, 'mockups'), { recursive: true });
  await writeFile(join(checkout, 'mockups', 'a.html'), '<p>a</p>');
  await writeFile(join(checkout, 'mockups', 'b.png'), Buffer.from([1, 2, 3]));
  await writeFile(join(root, 'secret.txt'), 'outside');
});

afterEach(async () => {
  await rm(root, { force: true, recursive: true });
});

test('reads named files of the checkout, each with its content type', async () => {
  expect(
    await readCheckoutFiles(
      checkout,
      ['mockups/a.html', './mockups/b.png'],
      1024,
    ),
  ).toEqual({
    files: [
      {
        content: Buffer.from('<p>a</p>').toString('base64'),
        contentType: 'text/html; charset=utf-8',
        path: 'mockups/a.html',
      },
      {
        content: Buffer.from([1, 2, 3]).toString('base64'),
        contentType: 'image/png',
        path: './mockups/b.png',
      },
    ],
  });
});

test('reads a symlink that stays inside the checkout', async () => {
  await symlink('a.html', join(checkout, 'mockups', 'link.html'));
  const answer = await readCheckoutFiles(
    checkout,
    ['mockups/link.html'],
    1024,
  );
  expect(answer).toMatchObject({ files: [{ path: 'mockups/link.html' }] });
});

describe('refuses', () => {
  test.each([
    ['../secret.txt', 'The path ../secret.txt is outside the checkout.'],
    [
      'mockups/../../secret.txt',
      'The path mockups/../../secret.txt is outside the checkout.',
    ],
    ['/etc/passwd', 'The path /etc/passwd is outside the checkout.'],
    ['', 'An empty path names no file.'],
    ['a\u0000b', 'A path may not contain a NUL character.'],
    ['.', 'The path . is not a file.'],
    ['mockups', 'The path mockups is not a file.'],
    ['missing.html', 'There is no file missing.html in the checkout.'],
  ])('%j', async (path, error) => {
    expect(await readCheckoutFiles(checkout, [path], 1024)).toEqual({ error });
  });

  test('a symlink that leads outside the checkout', async () => {
    await symlink(join(root, 'secret.txt'), join(checkout, 'escape'));
    expect(await readCheckoutFiles(checkout, ['escape'], 1024)).toEqual({
      error: 'The path escape is outside the checkout.',
    });
  });

  test('a directory symlink that leads outside the checkout', async () => {
    await symlink(root, join(checkout, 'up'));
    expect(await readCheckoutFiles(checkout, ['up/secret.txt'], 1024)).toEqual(
      { error: 'The path up/secret.txt is outside the checkout.' },
    );
  });

  test('files that come to more than the limit together', async () => {
    expect(
      await readCheckoutFiles(checkout, ['mockups/a.html', 'mockups/b.png'], 10),
    ).toEqual({
      error: 'The files asked for come to more than 10 bytes.',
    });
  });

  test('the whole request when any one path is refused', async () => {
    expect(
      await readCheckoutFiles(checkout, ['mockups/a.html', '../secret.txt'], 1024),
    ).toEqual({ error: 'The path ../secret.txt is outside the checkout.' });
  });
});
