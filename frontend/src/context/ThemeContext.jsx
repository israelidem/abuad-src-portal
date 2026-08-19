/**
 * Theme preference: light, dark, or follow the system.
 *
 * The class is applied to <html> in an inline script in index.html *before*
 * React mounts. Doing it here alone would paint a white screen first and
 * flash on every load for dark-mode users.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';

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

/**
 * The OS colour-scheme preference, as an external store.
 *
 * `matchMedia` is state that lives outside React, which is precisely what
 * useSyncExternalStore exists for. The alternative — mirroring it into
 * useState and refreshing it from an effect — is what caused the original
 * bug: the listener mutated the DOM directly while React's copy went
 * stale, so `resolved` disagreed with what was on screen. It also trips
 * the "setState synchronously within an effect" rule, because that is
 * genuinely what it was doing.
 *
 * Subscribing this way keeps one source of truth and cannot tear.
 */
const darkQuery = () =>
  typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null;

const subscribeToSystemTheme = (onChange) => {
  const query = darkQuery();
  if (!query) return () => {};
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
};

const getSystemIsDark = () => darkQuery()?.matches ?? false;

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(readStored);

  // Always subscribed, not just while on "system". If the OS changes while
  // an explicit theme is active and the user later switches back to
  // "system", this is already correct — no stale snapshot to reconcile.
  //
  // The third argument is the server snapshot; the app is client-rendered,
  // but supplying it keeps this safe if that ever changes.
  const systemDark = useSyncExternalStore(
    subscribeToSystemTheme,
    getSystemIsDark,
    () => false
  );

  const resolved = theme === 'system' ? (systemDark ? 'dark' : 'light') : theme;

  // The only place the class is applied. Previously two effects wrote it,
  // which is how they were able to disagree.
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('dark', resolved === 'dark');
    // Makes native controls (scrollbars, date pickers) match the theme.
    root.style.colorScheme = resolved;
  }, [resolved]);

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
