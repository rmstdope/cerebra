import { packageName } from '@cerebra/backend';
import { expect, test } from 'vitest';

test('identifies the backend package', () => {
  expect(packageName).toBe('@cerebra/backend');
});
