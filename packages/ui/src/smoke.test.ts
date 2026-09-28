import { packageName } from './package.js';
import { expect, test } from 'vitest';

test('identifies the UI package', () => {
  expect(packageName).toBe('@cerebra/ui');
});
