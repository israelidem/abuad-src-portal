/**
 * Applies a .sql migration statement by statement.
 *
 *   node scripts/apply-sql.mjs prisma/sql/07_signup_control.sql
 *
 * The Supabase SQL editor wraps a pasted script in one implicit
 * transaction, so a single failing statement rolls back everything before
 * it — which is how 07 managed to fail on its seed INSERT and leave the
 * ALTERs it had already run apparently undone. That is the right default
 * for a data migration and the wrong one for a set of independently
 * idempotent DDL statements.
 *
 * This runner executes each statement separately: a failure stops the run
 * and reports which statement broke, without discarding the ones that
 * already succeeded. Combined with `if not exists` / `drop ... if exists`
 * everywhere, re-running after a fix is safe.
 *
 * Verification SELECTs at the end of these files are executed too; their
 * output is not printed. Use scripts/inspect-settings.mjs to inspect
 * results, or run them in the SQL editor where you can read them.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { prisma } from '../src/lib/prisma.js';

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/apply-sql.mjs <path-to.sql>');
  process.exit(1);
}

/**
 * Splits SQL on semicolons that terminate a statement.
 *
 * Naive splitting breaks on `$$ ... $$` function bodies, which contain
 * their own semicolons — these migrations define triggers and helpers that
 * way, so dollar-quoted blocks are tracked and kept whole. Line comments
 * are stripped first so a `--` containing a semicolon can't split a
 * statement either.
 */
const splitStatements = (sql) => {
  const statements = [];
  let current = '';
  let dollarTag = null;

  for (const rawLine of sql.split('\n')) {
    // Strip `--` comments, but not inside a dollar-quoted body.
    const line = dollarTag ? rawLine : rawLine.replace(/--.*$/, '');
    if (!line.trim() && !current.trim()) continue;

    current += line + '\n';

    // Toggle in/out of $$ ... $$ or $tag$ ... $tag$
    for (const match of line.matchAll(/\$([A-Za-z_]*)\$/g)) {
      const tag = match[0];
      if (dollarTag === null) dollarTag = tag;
      else if (dollarTag === tag) dollarTag = null;
    }

    if (dollarTag === null && line.trimEnd().endsWith(';')) {
      if (current.trim()) statements.push(current.trim());
      current = '';
    }
  }

  if (current.trim()) statements.push(current.trim());
  return statements;
};

/** First line of a statement, for readable progress output. */
const label = (statement) =>
  statement.replace(/\s+/g, ' ').slice(0, 78) + (statement.length > 78 ? '…' : '');

const path = resolve(process.cwd(), file);
const sql = await readFile(path, 'utf8');
const statements = splitStatements(sql);

console.log(`\n${file} — ${statements.length} statements\n`);

let applied = 0;
try {
  for (const [i, statement] of statements.entries()) {
    const n = String(i + 1).padStart(2, ' ');
    try {
      await prisma.$executeRawUnsafe(statement);
      applied += 1;
      console.log(`  ${n}  ok    ${label(statement)}`);
    } catch (error) {
      const message = error?.meta?.message ?? error?.message?.split('\n')[0] ?? String(error);
      console.error(`  ${n}  FAIL  ${label(statement)}`);
      console.error(`\n      ${message}\n`);
      console.error(
        `Stopped at statement ${i + 1}. The ${applied} statement(s) before it are ` +
          `committed —\nthis runner does not wrap the file in a transaction. Fix the ` +
          `statement above and\nre-run; every statement in these files is idempotent.\n`
      );
      process.exitCode = 1;
      break;
    }
  }

  if (process.exitCode !== 1) {
    console.log(`\nApplied ${applied}/${statements.length} statements.\n`);
  }
} finally {
  await prisma.$disconnect();
}
