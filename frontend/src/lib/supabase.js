/**
 * Supabase browser client.
 *
 * Uses the anon key only — it's safe to ship, because Row Level Security
 * decides what each token can actually read. The service-role key must
 * never appear in frontend code.
 *
 * Login, signup confirmation, password reset and token refresh all run
 * through this client. Signup itself goes via our API so the
 * email-domain policy can be enforced.
 */

import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error(
    'Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY.\n' +
      'Copy frontend/.env.example to frontend/.env and fill both in.'
  );
}

export const supabase = createClient(url, anonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    // Needed so the email-confirmation and password-reset links,
    // which arrive as URL fragments, are picked up on load.
    detectSessionInUrl: true,
  },
});

/** Current access token, or null. Used to authorise API calls. */
export const getAccessToken = async () => {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
};
