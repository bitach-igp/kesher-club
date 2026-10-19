// Every workspace package typechecks with `erasableSyntaxOnly` (T-0018). Node's type stripping
// (`node --experimental-strip-types`, how `start` runs the api and simulators) rejects parameter
// properties, enums, namespaces and `import x = require()`; the flag makes `pnpm typecheck` reject
// them first. tsconfig.base.json sets it; this catches a package whose tsconfig does not extend the
// base (apps/admin) or turns the flag off.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
const packages = ['apps', 'packages']
  .flatMap((dir) => fs.readdirSync(path.join(root, dir)).map((name) => path.join(dir, name)))
  .filter((dir) => fs.existsSync(path.join(root, dir, 'tsconfig.json')));

test('the workspace has packages to check', () => {
  assert.ok(packages.length > 0);
});

for (const dir of packages) {
  test(`${dir} typechecks with erasableSyntaxOnly`, () => {
    const config = JSON.parse(execFileSync(process.execPath, [tsc, '-p', path.join(root, dir, 'tsconfig.json'), '--showConfig'], { encoding: 'utf8' }));
    assert.equal(config.compilerOptions?.erasableSyntaxOnly, true);
  });
}
