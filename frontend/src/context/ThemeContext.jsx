/**
 * Theme preference: light, dark, or follow the system.
 *
 * The class is applied to <html> in an inline script in index.html *before*
 * React mounts. Doing it here alone would paint a white screen first and
 * flash on every load for dark-mode users.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

const ThemeContext = createContext(null);

export const useTheme = () => {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside <ThemeProvider>.');
  return ctx;
};

const STORAGE_KEY = 'abuad-theme';
const THEMES = ['light', 'dark', 'system'];

const readStored = () => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return THEMES.includes(stored) ? stored : 'system';
  } catch {
    // Safari in private mode throws on localStorage — fall back rather
    // than take the whole app down over a colour preference.
    return 'system';
  }
};

const prefersDark = () =>
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-color-scheme: dark)').matches;

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(readStored);

  const resolved = theme === 'system' ? (prefersDark() ? 'dark' : 'light') : theme;

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('dark', resolved === 'dark');
    // Makes native controls (scrollbars, date pickers) match the theme.
    root.style.colorScheme = resolved;
  }, [resolved]);

  // Only relevant on "system" — follows the OS if it changes while open.
  useEffect(() => {
    if (theme !== 'system') return undefined;

    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e) => {
      document.documentElement.classList.toggle('dark', e.matches);
      document.documentElement.style.colorScheme = e.matches ? 'dark' : 'light';
    };

    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [theme]);

  const setTheme = useCallback((next) => {
    if (!THEMES.includes(next)) return;
    setThemeState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Preference just won't persist; the session still works.
    }
  }, []);

  const value = useMemo(
    () => ({
      theme,
      resolved,
      setTheme,
      toggle: () => setTheme(resolved === 'dark' ? 'light' : 'dark'),
    }),
    [theme, resolved, setTheme]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
