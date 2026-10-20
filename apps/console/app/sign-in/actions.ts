'use server';
// Sign-in server actions (T-0608): the console's server relays the API's passkey ceremony, so the token
// pair goes straight from the API into httpOnly cookies and never reaches page script. The device id is
// the console's install id, kept in its own cookie.
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { consoleApi, statusOf } from '../../src/api.ts';
import { getConfig } from '../../src/config.ts';
import { cookieOptions, cookieWrites, DEVICE_COOKIE, DEVICE_COOKIE_SECONDS } from '../../src/session.ts';

const api = () => consoleApi(getConfig().CONSOLE_API_URL);

/** The discoverable-credential options for this console's device; mints the device id on first use. */
export async function beginSignIn(): Promise<{ ok: true; options: unknown } | { ok: false; error: 'unavailable' }> {
  const jar = await cookies();
  let device = jar.get(DEVICE_COOKIE)?.value;
  if (!device) {
    device = `console-${crypto.randomUUID()}`;
    jar.set(DEVICE_COOKIE, device, cookieOptions(getConfig().CONSOLE_ENVIRONMENT, DEVICE_COOKIE_SECONDS));
  }
  try {
    return { ok: true, options: (await api().authenticate(device)).options };
  } catch (e) {
    if (statusOf(e) === undefined) throw e;
    return { ok: false, error: 'unavailable' };
  }
}

/** Verifies the assertion through the API and writes the pair; a refused passkey says so, nothing more. */
export async function finishSignIn(response: unknown): Promise<{ ok: true } | { ok: false; error: 'rejected' | 'unavailable' }> {
  const jar = await cookies();
  const device = jar.get(DEVICE_COOKIE)?.value;
  if (!device) return { ok: false, error: 'rejected' };
  let tokens;
  try {
    tokens = (await api().authenticate(device, response)).tokens;
  } catch (e) {
    const status = statusOf(e);
    if (status === undefined) throw e;
    return { ok: false, error: status === 401 || status === 422 ? 'rejected' : 'unavailable' };
  }
  if (!tokens) return { ok: false, error: 'rejected' };
  for (const c of cookieWrites(tokens, getConfig().CONSOLE_ENVIRONMENT, new Date())) jar.set(c.name, c.value, c.options);
  return { ok: true };
}

export async function signOut(): Promise<never> {
  const jar = await cookies();
  for (const c of cookieWrites('clear', getConfig().CONSOLE_ENVIRONMENT, new Date())) jar.set(c.name, c.value, c.options);
  redirect('/sign-in');
}
