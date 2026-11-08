// Console configuration (T-0608, constitution art. 6): read once through Zod, crash when missing.
import { loadConfig } from '@kesher/domain';
import { z } from 'zod';

const schema = z.object({
  /** local | preview | staging | production. Only `local` offers the seeded demo personas and plain-http cookies. */
  CONSOLE_ENVIRONMENT: z.enum(['local', 'preview', 'staging', 'production']),
  /** The API's base URL, with /v1. */
  CONSOLE_API_URL: z.url(),
}).superRefine((c, ctx) => {
  // Outside `local` the console is the public face of the API it calls (T-0047): https, never this machine.
  // The message names the key, never the value: it reaches the boot log.
  if (c.CONSOLE_ENVIRONMENT === 'local') return;
  const url = new URL(c.CONSOLE_API_URL);
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if (url.protocol !== 'https:' || loopback) ctx.addIssue({ code: 'custom', path: ['CONSOLE_API_URL'], message: 'must be https and not a loopback host outside CONSOLE_ENVIRONMENT=local' });
});

export type ConsoleConfig = z.infer<typeof schema>;

let cached: ConsoleConfig | undefined;
export function getConfig(env: Record<string, string | undefined> = process.env): ConsoleConfig {
  cached ??= loadConfig(schema, env);
  return cached;
}
