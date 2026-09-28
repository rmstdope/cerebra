import { packageName } from '@cerebra/ui';
import { expect, test } from 'vitest';

test('identifies the UI package', () => {
  expect(packageName).toBe('@cerebra/ui');
});
