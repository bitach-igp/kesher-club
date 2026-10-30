// T-0120: the SDK binding sends this install's device id with both steps of every passkey ceremony, and
// the enrolment's purpose, so the server can key the challenge, the device row and later refreshes by it.
import { describe, expect, it } from 'vitest';
import { createClient } from '@kesher/sdk';
import { sdkApi } from './api.ts';
import { memorySession } from './session.ts';

const unused = () => Promise.reject(new Error('not used'));

function bound() {
  const bodies: { path: string; body: Record<string, unknown> }[] = [];
  const fetch = (async (url: URL, init?: RequestInit) => {
    bodies.push({ path: new URL(url).pathname, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
    return new Response(JSON.stringify({ options: { challenge: 'c' } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  const client = createClient({ baseUrl: 'http://localhost:3000/v1', fetch });
  const api = sdkApi(client, memorySession('install-7f3a'), { esim: { usage: unused }, concierge: { start: unused } } as unknown as Parameters<typeof sdkApi>[2]);
  return { api, bodies };
}

describe('passkey binding (T-0120)', () => {
  it('sends the install id and the purpose on both registration steps', async () => {
    const { api, bodies } = bound();
    await api.auth.registerPasskey({ purpose: 'recovery', deviceName: 'Pixel' });
    await api.auth.registerPasskey({ purpose: 'recovery', response: { id: 'r' } });
    expect(bodies.map((b) => b.body)).toEqual([
      { deviceId: 'install-7f3a', purpose: 'recovery', deviceName: 'Pixel' },
      { deviceId: 'install-7f3a', purpose: 'recovery', response: { id: 'r' } },
    ]);
  });

  it('sends the install id on both sign-in steps', async () => {
    const { api, bodies } = bound();
    await api.auth.authenticatePasskey({});
    await api.auth.authenticatePasskey({ response: { id: 'a' } });
    expect(bodies).toEqual([
      { path: '/v1/auth/passkeys/authenticate', body: { deviceId: 'install-7f3a' } },
      { path: '/v1/auth/passkeys/authenticate', body: { deviceId: 'install-7f3a', response: { id: 'a' } } },
    ]);
  });
});
