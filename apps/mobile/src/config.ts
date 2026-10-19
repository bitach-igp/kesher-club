// The member app's build-time configuration (T-0033). Expo inlines each `process.env.EXPO_PUBLIC_*` it
// finds spelled out in full, so `buildEnv()` names both keys literally and nothing else reads them.
// A bad value fails the bundle's start with a ConfigError that names the key, never the value.
import { APP_ENVS, ConfigError } from '@kesher/domain';

export type AppEnv = (typeof APP_ENVS)[number];

export interface MobileConfig {
  /** The API's base URL, `/v1` included or not. */
  apiUrl: string;
  appEnv: AppEnv;
}

export interface MobileEnv {
  EXPO_PUBLIC_API_URL?: string | undefined;
  EXPO_PUBLIC_APP_ENV?: string | undefined;
}

/** Plain http only to this machine: a development build against the local stack (T-0031). */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

export function parseMobileConfig(env: MobileEnv): MobileConfig {
  const missing: string[] = [];
  const invalid: string[] = [];
  const rawUrl = env.EXPO_PUBLIC_API_URL;
  const rawEnv = env.EXPO_PUBLIC_APP_ENV;
  if (!rawUrl) missing.push('EXPO_PUBLIC_API_URL');
  if (!rawEnv) missing.push('EXPO_PUBLIC_APP_ENV');

  let apiUrl = '';
  if (rawUrl) {
    let url: URL | undefined;
    try {
      url = new URL(rawUrl);
    } catch {
      invalid.push('EXPO_PUBLIC_API_URL: not a URL');
    }
    if (url && url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) invalid.push('EXPO_PUBLIC_API_URL: must be https, or http on localhost');
    else if (url) apiUrl = url.href.replace(/\/$/, '');
  }
  const appEnv = APP_ENVS.find((e) => e === rawEnv);
  if (rawEnv && !appEnv) invalid.push(`EXPO_PUBLIC_APP_ENV: must be one of ${APP_ENVS.join(', ')}`);

  if (missing.length || invalid.length || !appEnv) throw new ConfigError(missing, invalid);
  return { apiUrl, appEnv };
}

/** The two keys as the bundler inlined them. */
export const buildEnv = (): MobileEnv => ({ EXPO_PUBLIC_API_URL: process.env.EXPO_PUBLIC_API_URL, EXPO_PUBLIC_APP_ENV: process.env.EXPO_PUBLIC_APP_ENV });
