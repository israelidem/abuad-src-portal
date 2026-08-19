/**
 * Deletes an account by email — auth user and profile together.
 *
 *   node scripts/delete-user.mjs someone@abuad.edu.ng
 *
 * For removing test accounts. Deleting only the Supabase auth user leaves
 * an orphaned profile row whose email still occupies the unique index,
 * which then blocks re-registration with a confusing "already exists" —
 * so both are removed, profile first.
 *
 * Refuses to run against a non-local API target unless ALLOW_REMOTE=1, to
 * make it awkward to point this at production by accident.
 */

import { prisma } from '../src/lib/prisma.js';
import { supabaseAdmin } from '../src/lib/supabase.js';

const email = process.argv[2]?.trim().toLowerCase();
if (!email) {
  console.error('usage: node scripts/delete-user.mjs <email>');
  process.exit(1);
}

const isLocalish = /localhost|127\.0\.0\.1/.test(process.env.API_URL ?? 'http://localhost:5000');
if (!isLocalish && process.env.ALLOW_REMOTE !== '1') {
  console.error('Refusing to run against a remote target. Set ALLOW_REMOTE=1 to override.');
  process.exit(1);
}

try {
  const profile = await prisma.profile.findUnique({
    where: { email },
    select: { id: true, email: true, fullName: true, role: true },
  });

  if (!profile) {
    console.log(`\nNo profile found for ${email} — nothing to delete.\n`);
    process.exit(0);
  }

  // Guard: never quietly delete a privileged account.
  if (profile.role !== 'STUDENT') {
    console.error(`\nRefusing to delete a ${profile.role} account (${email}).\n`);
    process.exit(1);
  }

  console.log(`\nDeleting ${profile.email} — ${profile.fullName} (${profile.role})`);

  await prisma.profile.delete({ where: { id: profile.id } });
  console.log('  profile row deleted');

  const { error } = await supabaseAdmin.auth.admin.deleteUser(profile.id);
  console.log(error ? `  auth user: ${error.message}` : '  auth user deleted');

  console.log(`\nDone. ${email} can register again.\n`);
} finally {
  await prisma.$disconnect();
}
