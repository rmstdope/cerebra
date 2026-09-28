import {
  getEffectiveTheme,
  getStoredTheme,
  setStoredTheme,
  type ThemePreference,
} from './theme';
import { describe, expect, test } from 'vitest';

describe('theme preferences', () => {
  test.each([
    ['light', false, 'light'],
    ['dark', true, 'dark'],
    ['system', false, 'light'],
    ['system', true, 'dark'],
  ] satisfies Array<[ThemePreference, boolean, 'light' | 'dark']>)(
    'resolves %s against the system preference',
    (preference, systemPrefersDark, expected) => {
      expect(getEffectiveTheme(preference, systemPrefersDark)).toBe(expected);
    },
  );

  test('uses System when no valid saved preference is available', () => {
    expect(getStoredTheme(null)).toEqual({ preference: 'system' });
    expect(getStoredTheme('unrecognised')).toEqual({ preference: 'system' });
  });

  test('reports a failed persistence write', () => {
    const storage = {
      setItem: () => {
        throw new Error('Storage is unavailable');
      },
    };

    expect(setStoredTheme(storage, 'dark')).toEqual({
      ok: false,
      error: 'Storage is unavailable',
    });
  });
});
