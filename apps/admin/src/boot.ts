// Boot check (T-0918), Node runtime only: instrumentation.ts imports it once when the server starts. A
// missing or bad setting stops the process the way it stops the API and the worker: one JSON line naming
// the keys, never their values, then exit 1. ECS restarts the task and the log says why; before this the
// task kept answering 500 with nothing in its log.
import { ConfigError } from '@kesher/domain';
import { getConfig } from './config.ts';

export function bootCheck(): void {
  try {
    getConfig();
  } catch (e) {
    const fields = e instanceof ConfigError ? { error: 'ConfigError', message: e.message } : { error: e instanceof Error ? e.name : 'Error', message: e instanceof Error ? e.message : String(e) };
    process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), service: 'admin', event: 'boot_failed', ...fields })}\n`);
    process.exit(1);
  }
}
