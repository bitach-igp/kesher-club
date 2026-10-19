import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

// `pnpm start` runs the sources through Node's type stripping, which rejects TypeScript-only runtime
// syntax (parameter properties, enums, namespaces, `import x = require()`). Vitest transpiles with
// esbuild and never notices, so load the real module graph the way `start` does (T-0016).
describe('strip-only boot', () => {
  it('imports the entry point and everything it loads under node --experimental-strip-types', () => {
    const entry = new URL('./index.ts', import.meta.url).href;
    const out = execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', `await import(${JSON.stringify(entry)}); console.log('loaded');`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(out.trim()).toBe('loaded');
  });
});
