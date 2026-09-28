import { packageName } from '@cerebra/shared';
import { expect, test } from 'vitest';

test('identifies the shared package', () => {
  expect(packageName).toBe('@cerebra/shared');
});
