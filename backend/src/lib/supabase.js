/**
 * Supabase Admin Client (service_role key).
 *
 * Used server-side for:
 *   - Creating auth users during signup (enforces domain policy via API)
 *   - Updating user metadata / roles via custom claims
 *   - Deleting auth users from the admin panel
 *
 * NEVER expose the service_role key to the browser.
 */

import { createClient } from '@supabase/supabase-js';
import { env } from '../config/env.js';

export const supabaseAdmin = createClient(
  env.supabase.url,
  env.supabase.serviceRoleKey,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  }
);
