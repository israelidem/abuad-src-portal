/**
 * Test runner with a compact summary.
 *
 * Exists because `node --test | findstr ...` is unreliable in cmd.exe: the
 * pipe swallows output when the child exits non-zero, so a failing suite
 * printed nothing at all — the worst possible failure mode for a test run.
 *
 * Prints per-file pass/fail counts and the assertion text of every failure,
 * then exits 0 so the surrounding shell cannot hide the report. The report
 * itself states whether the suite passed; the exit code is not the channel.
 *
 * Usage: node scripts/run-tests.mjs
 */

import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const backendRoot = resolve(here, '..');
const testsDir = resolve(backendRoot, 'tests');

const files = readdirSync(testsDir).filter((f) => f.endsWith('.test.mjs')).sort();

const runFile = (file) =>
  new Promise((resolveRun) => {
    // --test-reporter=tap is required, not optional. Node 22+ defaults to
    // the `spec` reporter, which emits no "# pass N" counters, so the first
    // version of this script parsed 0/0 out of every file and then printed
    // "PASS" for all ten — a harness that reported success without having
    // observed a single assertion.
    const child = spawn(process.execPath, ['--test', '--test-reporter=tap', `tests/${file}`], {
      cwd: backendRoot,
      env: { ...process.env, NODE_ENV: 'test' },
    });

    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });

    child.on('close', (code) => {
      const pass = Number(/^# pass (\d+)/m.exec(out)?.[1] ?? 0);
      const fail = Number(/^# fail (\d+)/m.exec(out)?.[1] ?? 0);

      // Capture the name of each failing test plus its assertion message.
      const failures = [];
      const re = /^not ok \d+ - (.+)$/gm;
      let m;
      while ((m = re.exec(out)) !== null) failures.push(m[1].trim());

      resolveRun({ file, pass, fail, code, failures, out });
    });
  });

const run = async () => {
  console.log(`\nBackend test suite — ${files.length} files\n`);

  let totalPass = 0;
  let totalFail = 0;
  const broken = [];

  for (const file of files) {
    // eslint-disable-next-line no-await-in-loop
    const r = await runFile(file);
    totalPass += r.pass;
    totalFail += r.fail;

    // pass > 0 is part of the criterion. Without it, a file that ran no
    // tests at all counts as passing, which is how the 0/0 bug above went
    // unnoticed.
    const status = r.fail === 0 && r.code === 0 && r.pass > 0 ? 'PASS' : 'FAIL';
    console.log(`  ${status}  ${file.padEnd(34)} ${r.pass} passed, ${r.fail} failed`);

    for (const f of r.failures) console.log(`         ↳ ${f}`);

    // A file that exits non-zero with no parsed failures did not run at all
    // — an import error or syntax error. That must not be reported as a
    // pass just because the TAP counters are absent.
    if (r.pass === 0 || (r.code !== 0 && r.fail === 0)) {
      broken.push(file);
      const firstErr = r.out.split('\n').find((l) => /Error|Cannot find|SyntaxError/.test(l));
      console.log(`         ↳ FILE DID NOT RUN: ${firstErr?.trim() ?? `exit ${r.code}`}`);
    }
  }

  console.log(`\n  TOTAL: ${totalPass} passed, ${totalFail} failed` +
    (broken.length ? `, ${broken.length} file(s) failed to run` : ''));
  console.log(totalFail === 0 && broken.length === 0 && totalPass > 0
    ? '  ✔ Suite green.\n'
    : '  ✖ Suite has failures.\n');
};

run();
