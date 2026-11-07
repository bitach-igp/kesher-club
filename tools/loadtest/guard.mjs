#!/usr/bin/env node
// The workflow's first step (T-0055): `node tools/loadtest/guard.mjs "$JIT_URL"` exits 1 before k6 is installed when the URL could be production.
import { assertNotProd } from './lib.mjs';

try {
  const t = assertNotProd(process.argv[2]);
  console.log(`JIT target host ${t.host} accepted`);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
