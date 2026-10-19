// @kesher/api entry point (T-0021): `pnpm --filter @kesher/api start`, or the container's command.
// Boots the API from the environment; a configuration problem exits 1 with the names of the bad keys
// and never their values. SIGTERM and SIGINT drain and exit 0.
import { pathToFileURL } from 'node:url';
import { ConfigError } from '@kesher/domain';
import { log, main } from './main.ts';

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    const api = await main(process.env);
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      process.once(signal, () => {
        log('signal', { signal });
        void api.shutdown().then(() => process.exit(0));
      });
    }
  } catch (e) {
    // A ConfigError's message names keys only; anything else prints its name and message, never a stack
    // that could carry a value.
    log('boot_failed', e instanceof ConfigError ? { error: 'ConfigError', message: e.message } : { error: e instanceof Error ? e.name : 'Error', message: e instanceof Error ? e.message : String(e) });
    process.exit(1);
  }
}
