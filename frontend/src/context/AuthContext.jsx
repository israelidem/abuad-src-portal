/**
 * Authentication context.
 *
 * The old app tracked `isAdminMode` in a useState with a hardcoded
 * password, so anyone could grant themselves admin from the console.
 *
 * Here the role comes from `GET /api/auth/me`, which reads the profiles
 * table server-side. The flags below (`isAdmin`, `isStaff`) only decide
 * what the UI *renders* — the API re-checks permissions on every request,
 * so tampering with client state changes nothing.
 */

import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '../lib/supabase.js';
import { authApi } from '../lib/api.js';

const AuthContext = createContext(null);

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>.');
  return ctx;
};

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  // Starts true so guarded routes show a spinner instead of bouncing
  // signed-in users to /login while the session is still loading.
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Guards against a slow profile fetch resolving after sign-out
  const activeUserId = useRef(null);
  // Mirrors `profile`. The auth listener's closure is created once, so
  // reading the state variable inside it would always see the initial null.
  const profileRef = useRef(null);

  const commitProfile = (value) => {
    profileRef.current = value;
    setProfile(value);
  };

  const loadProfile = async (userId) => {
    activeUserId.current = userId;
    try {
      const { profile: fetched } = await authApi.me();
      if (activeUserId.current !== userId) return; // stale response
      commitProfile(fetched);
      setError(null);
    } catch (err) {
      if (activeUserId.current !== userId) return;
      commitProfile(null);
      // A 401 here means the token is stale — sign out rather than
      // leave the UI in a half-authenticated state.
      if (err.status === 401) {
        await supabase.auth.signOut();
      } else {
        setError(err.message);
      }
    }
  };

  useEffect(() => {
    let cancelled = false;

    // Existing session on first load
    supabase.auth.getSession().then(async ({ data }) => {
      if (cancelled) return;
      setSession(data.session ?? null);
      if (data.session?.user) await loadProfile(data.session.user.id);
      if (!cancelled) setLoading(false);
    });

    // Keeps state in sync across login, logout, refresh and other tabs
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (event, newSession) => {
      if (cancelled) return;

      setSession(newSession ?? null);

      if (!newSession?.user) {
        activeUserId.current = null;
        commitProfile(null);
        setLoading(false);
        return;
      }

      // TOKEN_REFRESHED fires often and the profile hasn't changed
      if (event === 'TOKEN_REFRESHED' && profileRef.current) return;

      // signIn() already loaded the profile before it resolved, so by the
      // time SIGNED_IN arrives we have it. Re-fetching would flip `loading`
      // back on and flash a spinner over the page we just navigated to.
      if (profileRef.current && activeUserId.current === newSession.user.id) return;

      setLoading(true);
      await loadProfile(newSession.user.id);
      if (!cancelled) setLoading(false);
    });

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const signIn = async (email, password) => {
    setError(null);
    const { data, error: signInError } = await supabase.auth.signInWithPassword({
      email: email.trim().toLowerCase(),
      password,
    });

    if (signInError) {
      // Supabase returns the same message for both cases by design
      const message =
        signInError.message === 'Invalid login credentials'
          ? 'Incorrect email or password.'
          : signInError.message;
      setError(message);
      throw new Error(message);
    }

    // Load the profile *before* resolving. Login navigates to a guarded
    // route the instant this returns; leaving the fetch to the
    // onAuthStateChange listener means the guard can run first, see
    // `isAuthenticated === false` and bounce straight back to /login.
    setSession(data.session ?? null);
    if (data.session?.user) {
      setLoading(true);
      await loadProfile(data.session.user.id);
      setLoading(false);
    }

    return data;
  };

  /**
   * Signup goes through our API, not supabase-js directly, so the
   * email-domain policy is applied. The user is signed in afterwards
   * only if the project has email confirmation switched off.
   */
  const signUp = async (payload) => {
    setError(null);
    const result = await authApi.signup(payload);

    if (result.session) {
      const { data } = await supabase.auth.setSession({
        access_token: result.session.access_token,
        refresh_token: result.session.refresh_token,
      });

      // Same reasoning as signIn: load the profile before resolving so the
      // caller can navigate straight to a guarded route. Waiting on the
      // onAuthStateChange listener instead would leave `isAuthenticated`
      // false for a moment, which `resolving` covers with a spinner — but
      // only by luck of timing. Doing it here makes it deterministic.
      const user = data?.session?.user ?? result.session.user;
      if (user) {
        setSession(data?.session ?? null);
        setLoading(true);
        await loadProfile(user.id);
        setLoading(false);
      }
    }

    return result;
  };

  const signOut = async () => {
    activeUserId.current = null;
    await supabase.auth.signOut();
    commitProfile(null);
    setSession(null);
  };

  const resetPassword = async (email) => {
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(
      email.trim().toLowerCase(),
      { redirectTo: `${window.location.origin}/reset-password` }
    );
    if (resetError) throw new Error(resetError.message);
  };

  const updatePassword = async (newPassword) => {
    const { error: updateError } = await supabase.auth.updateUser({ password: newPassword });
    if (updateError) throw new Error(updateError.message);
  };

  /** Optimistically merge a profile update without a round trip. */
  const updateProfile = async (updates) => {
    const { profile: updated } = await authApi.updateMe(updates);
    commitProfile(updated);
    return updated;
  };

  const value = useMemo(
    () => ({
      session,
      user: session?.user ?? null,
      profile,
      loading,
      error,

      isAuthenticated: Boolean(session && profile),

      // True while we still don't know who the user is: either the initial
      // session check is in flight, or a session exists but its profile
      // hasn't arrived. Guards must wait on this rather than on `loading`,
      // or they redirect during that gap.
      resolving: loading || (Boolean(session?.user) && !profile && !error),
      // SUPER_ADMIN sits above ADMIN, so it satisfies both flags. Listing
      // only 'ADMIN' would hide the admin UI from the one account that
      // most needs it.
      isSuperAdmin: profile?.role === 'SUPER_ADMIN',
      isAdmin: profile?.role === 'ADMIN' || profile?.role === 'SUPER_ADMIN',
      isStaff:
        profile?.role === 'REP' ||
        profile?.role === 'ADMIN' ||
        profile?.role === 'SUPER_ADMIN',
      role: profile?.role ?? null,

      signIn,
      signUp,
      signOut,
      resetPassword,
      updatePassword,
      updateProfile,
      refreshProfile: () => (session?.user ? loadProfile(session.user.id) : null),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session, profile, loading, error]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
