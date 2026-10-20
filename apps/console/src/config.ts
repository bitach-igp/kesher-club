// Console configuration (T-0608, constitution art. 6): read once through Zod, crash when missing.
import { loadConfig } from '@kesher/domain';
import { z } from 'zod';

const schema = z.object({
  /** local | preview | staging | production. Only `local` offers the seeded demo personas and plain-http cookies. */
  CONSOLE_ENVIRONMENT: z.enum(['local', 'preview', 'staging', 'production']),
  /** The API's base URL, with /v1. */
  CONSOLE_API_URL: z.url(),
});

export type ConsoleConfig = z.infer<typeof schema>;

let cached: ConsoleConfig | undefined;
export function getConfig(env: Record<string, string | undefined> = process.env): ConsoleConfig {
  cached ??= loadConfig(schema, env);
  return cached;
}
