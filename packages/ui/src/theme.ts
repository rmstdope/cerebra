export const themeStorageKey = 'cerebra.theme';

export type ThemePreference = 'light' | 'dark' | 'system';
export type EffectiveTheme = Exclude<ThemePreference, 'system'>;

export type ThemeStorageWriter = Pick<Storage, 'setItem'>;

export function getEffectiveTheme(
  preference: ThemePreference,
  systemPrefersDark: boolean,
): EffectiveTheme {
  if (preference === 'system') {
    return systemPrefersDark ? 'dark' : 'light';
  }

  return preference;
}

export function getStoredTheme(value: string | null): {
  preference: ThemePreference;
} {
  if (value === 'light' || value === 'dark' || value === 'system') {
    return { preference: value };
  }

  return { preference: 'system' };
}

export function setStoredTheme(
  storage: ThemeStorageWriter,
  preference: ThemePreference,
): { ok: true } | { ok: false; error: string } {
  try {
    storage.setItem(themeStorageKey, preference);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Storage is unavailable',
    };
  }
}
