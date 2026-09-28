import { packageName } from './index.js';
import { expect, test } from 'vitest';

test('identifies the runner package', () => {
  expect(packageName).toBe('@cerebra/runner');
});
