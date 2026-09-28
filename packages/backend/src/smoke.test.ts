import { packageName } from './index.js';
import { expect, test } from 'vitest';

test('identifies the backend package', () => {
  expect(packageName).toBe('@cerebra/backend');
});
