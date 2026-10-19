import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Node's type stripping rejects TypeScript-only runtime syntax (parameter properties, enums,
// namespaces, `import x = require()`); Vitest transpiles with esbuild and never notices. The entry
// point wires nothing yet, so load every non-test module the way `node --experimental-strip-types`
// would run it (T-0017).
describe('strip-only load', () => {
  it('imports every source module under node --experimental-strip-types', () => {
    const src = new URL('./', import.meta.url);
    const modules = readdirSync(src, { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .map((f) => new URL(f, src).href);
    const script = `for (const m of ${JSON.stringify(modules)}) await import(m); console.log('loaded', ${modules.length});`;
    const out = execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', script], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(out.trim()).toBe(`loaded ${modules.length}`);
  }, 30_000);
});
