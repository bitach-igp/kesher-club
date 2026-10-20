import { defineConfig } from 'vitest/config';

// The recordings under src/record are Playwright specs (T-0920), run by `pnpm record`, not by vitest.
export default defineConfig({
  test: { include: ['src/**/*.test.ts'] },
});
