// Tests run on Node; screen smoke tests render through react-native-web in jsdom
// (`// @vitest-environment jsdom` at the top of the file). Typecheck uses react-native's own types.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { 'react-native': 'react-native-web' } },
  test: { include: ['src/**/*.test.{ts,tsx}', 'app/**/*.test.{ts,tsx}'] },
});
