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

  const loadProfile = async (userId) => {
    activeUserId.current = userId;
    try {
      const { profile: fetched } = await authApi.me();
      if (activeUserId.current !== userId) return; // stale response
      setProfile(fetched);
      setError(null);
    } catch (err) {
      if (activeUserId.current !== userId) return;
      setProfile(null);
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
        setProfile(null);
        setLoading(false);
        return;
      }

      // TOKEN_REFRESHED fires often and the profile hasn't changed
      if (event === 'TOKEN_REFRESHED' && profile) return;

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
      await supabase.auth.setSession({
        access_token: result.session.access_token,
        refresh_token: result.session.refresh_token,
      });
    }

    return result;
  };

  const signOut = async () => {
    activeUserId.current = null;
    await supabase.auth.signOut();
    setProfile(null);
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
    setProfile(updated);
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
      isAdmin: profile?.role === 'ADMIN',
      isStaff: profile?.role === 'REP' || profile?.role === 'ADMIN',
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
