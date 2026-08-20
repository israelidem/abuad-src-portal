/**
 * Throwaway probe: what does the installed express-rate-limit actually
 * support? Version matters here — v7 renamed `max` to `limit` and v7.5
 * added `ipKeyGenerator`, and guessing wrong produces a limiter that
 * silently fails open rather than erroring.
 */
import { readFileSync } from 'fs';
import * as erl from 'express-rate-limit';

// The package blocks deep imports of its own package.json via `exports`,
// so read it off disk instead.
const pkg = JSON.parse(
  readFileSync(
    new URL('../node_modules/express-rate-limit/package.json', import.meta.url),
    'utf8'
  )
);

console.log('installed version:', pkg.version);
console.log('named exports    :', Object.keys(erl).join(', '));
console.log('ipKeyGenerator   :', typeof erl.ipKeyGenerator);


