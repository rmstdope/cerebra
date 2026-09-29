import { expect, test } from 'vitest';

import {
  failedSentence,
  finishedSentence,
  firstBackupSentence,
  keepsLabel,
  keptSentence,
  queueWhen,
  sizeLabel,
  whenLabel,
} from './backups';

// Local times, so the expectations hold in any time zone. 28 Sep 2026 is a Monday.
const at = (day: number, hour: number, minute = 0) =>
  new Date(2026, 8, day, hour, minute);
const now = at(28, 14, 0);

test('names the day of a time relative to now', () => {
  expect(whenLabel(at(28, 2, 14), now)).toBe('Today, 02:14');
  expect(whenLabel(at(27, 2, 13), now)).toBe('Yesterday, 02:13');
  expect(whenLabel(at(29, 2), now)).toBe('Tomorrow, 02:00');
  expect(whenLabel(at(26, 2, 15), now)).toBe('Saturday, 02:15');
  expect(whenLabel(at(12, 2, 15), now)).toBe('12 Sep, 02:15');
  expect(queueWhen(at(28, 2), now)).toBe('Today at 02:00');
});

test('says when the latest backup finished', () => {
  expect(finishedSentence(at(28, 2, 14), now)).toBe(
    'The latest backup finished today at 02:14.',
  );
  expect(finishedSentence(at(27, 2, 14), now)).toBe(
    'The latest backup finished yesterday at 02:14.',
  );
  expect(finishedSentence(at(22, 2, 14), now)).toBe(
    'The latest backup finished on Tuesday at 02:14.',
  );
});

test('says tonight only for a night-time run that is still ahead', () => {
  expect(firstBackupSentence(at(29, 2), now)).toBe(
    'The first backup runs tonight at 02:00.',
  );
  expect(firstBackupSentence(at(28, 22), now)).toBe(
    'The first backup runs tonight at 22:00.',
  );
  expect(firstBackupSentence(at(28, 16), now)).toBe(
    'The first backup runs today at 16:00.',
  );
  expect(firstBackupSentence(at(29, 12), now)).toBe(
    'The first backup runs tomorrow at 12:00.',
  );
});

test('names the failed backup and its cause', () => {
  const rest =
    'failed: the backup folder is full. Your earlier backups are untouched. Cerebra will try again at the next scheduled time.';
  expect(failedSentence(at(28, 2), 'the backup folder is full', now)).toBe(
    `Tonight’s backup at 02:00 ${rest}`,
  );
  expect(failedSentence(at(27, 23), 'the backup folder is full', now)).toBe(
    `Tonight’s backup at 23:00 ${rest}`,
  );
  expect(failedSentence(at(28, 11), 'the backup folder is full', now)).toBe(
    `Today’s backup at 11:00 ${rest}`,
  );
  expect(failedSentence(at(27, 2), 'the backup folder is full', now)).toBe(
    `Yesterday’s backup at 02:00 ${rest}`,
  );
  expect(failedSentence(at(12, 2), 'the backup folder is full', now)).toBe(
    `The backup on 12 Sep at 02:00 ${rest}`,
  );
});

test('shows sizes in decimal units', () => {
  expect(sizeLabel(512)).toBe('512 B');
  expect(sizeLabel(812_000)).toBe('812 KB');
  expect(sizeLabel(48_200_000)).toBe('48.2 MB');
  expect(sizeLabel(1_300_000_000)).toBe('1.3 GB');
  expect(sizeLabel(999_960)).toBe('1.0 MB');
});

test('counts backups in words', () => {
  expect(keptSentence(1)).toBe(
    '1 backup kept. Older ones are removed automatically.',
  );
  expect(keptSentence(7)).toBe(
    '7 backups kept. Older ones are removed automatically.',
  );
  expect(keepsLabel(7)).toBe('The last 7 backups');
  expect(keepsLabel(1)).toBe('The last backup');
});
