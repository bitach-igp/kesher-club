// @vitest-environment jsdom
// T-0033: the root layout routes on the session, and the authenticator is chosen by the build alone: a
// development build signs as a picked demo persona, every other build uses the platform's WebAuthn even
// when the API sends the simulator's options. The config refuses plain http anywhere but localhost.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthSimulator, type PasskeyAuthenticationOptions, type PasskeyRegistrationOptions } from '@kesher/ports';
import { memoryRouter } from '../src/navigation.ts';
import { memorySession } from '../src/session.ts';

vi.mock('expo-router', () => ({ Slot: () => null, useRouter: () => ({}), useSegments: () => [], useGlobalSearchParams: () => ({}), useRootNavigationState: () => ({ key: 'root' }) }));

const config = { apiUrl: 'http://localhost:3000', appEnv: 'development' as const };

/** The layout module as a bundle built with this EXPO_PUBLIC_APP_ENV sees it. */
async function layoutFor(appEnv: string) {
  vi.resetModules();
  vi.stubEnv('EXPO_PUBLIC_APP_ENV', appEnv);
  return import('./_layout.tsx');
}

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('routing on the session', () => {
  it('signed out, it routes to (auth)/sign-in; signed in, to (tabs)/home', async () => {
    const { RootLayoutView, createRootDeps } = await layoutFor('preview');
    const deps = createRootDeps(config);
    const router = memoryRouter('/');
    const { rerender } = render(<RootLayoutView deps={deps} router={router} segments={[]} />);
    expect(router.current()).toBe('/(auth)/sign-in');

    deps.session.signIn({ accessToken: 'at', refreshToken: 'rt', accessExpiresAt: '2026-11-01T09:10:00Z' });
    rerender(<RootLayoutView deps={deps} router={router} segments={['(auth)', 'sign-in']} />);
    expect(router.current()).toBe('/(tabs)/home');
  });

  it('leaves a signed-out member on sign-in and a signed-in one on their tab', async () => {
    const { guard } = await layoutFor('preview');
    expect(guard(false, ['(auth)', 'sign-in'])).toBeUndefined();
    expect(guard(true, ['(tabs)', 'home'])).toBeUndefined();
    expect(guard(false, ['(tabs)', 'home'])).toBe('/(auth)/sign-in');
    expect(guard(true, ['+not-found'])).toBe('/(tabs)/home');
  });

  it('an assistant\'s consent request survives sign-in; nothing else does (T-1017)', async () => {
    const { RootLayoutView, createRootDeps, resumable } = await layoutFor('preview');
    expect([resumable(['connect', '[id]'], { id: 'req 1' }), resumable(['pay'], { id: 'x' }), resumable(['connect', '[id]'], {})]).toEqual(['/connect/req%201', undefined, undefined]);
    const deps = createRootDeps(config);
    const router = memoryRouter('/connect/req-1');
    const { rerender } = render(<RootLayoutView deps={deps} router={router} segments={['connect', '[id]']} params={{ id: 'req-1' }} />);
    expect(router.current()).toBe('/(auth)/sign-in');
    rerender(<RootLayoutView deps={deps} router={router} segments={['(auth)', 'sign-in']} />);
    deps.session.signIn({ accessToken: 'at', refreshToken: 'rt', accessExpiresAt: '2026-11-01T09:10:00Z' });
    rerender(<RootLayoutView deps={deps} router={router} segments={['(auth)', 'sign-in']} />);
    expect(router.current()).toBe('/connect/req-1');
    // Used once: the next time the member signs in, they start at Home.
    deps.session.signOut();
    rerender(<RootLayoutView deps={deps} router={router} segments={['(tabs)', 'home']} />);
    deps.session.signIn({ accessToken: 'at2', refreshToken: 'rt2', accessExpiresAt: '2026-11-01T09:10:00Z' });
    rerender(<RootLayoutView deps={deps} router={router} segments={['(auth)', 'sign-in']} />);
    expect(router.current()).toBe('/(tabs)/home');
  });

  it('a roster invite is read signed out, comes back after sign-in, and keeps the signed-in member (T-0626)', async () => {
    const { RootLayoutView, createRootDeps, guard, resumable } = await layoutFor('preview');
    expect(resumable(['(auth)', 'invite'], { token: 'tok/1' })).toBe('/(auth)/invite?token=tok%2F1');
    expect([resumable(['(auth)', 'invite'], {}), resumable(['(auth)', 'sign-in'], { token: 'x' })]).toEqual([undefined, undefined]);
    expect([guard(false, ['(auth)', 'invite']), guard(true, ['(auth)', 'invite'])]).toEqual([undefined, undefined]);
    const deps = createRootDeps(config);
    const router = memoryRouter('/(auth)/invite?token=tok-1');
    const { rerender } = render(<RootLayoutView deps={deps} router={router} segments={['(auth)', 'invite']} params={{ token: 'tok-1' }} />);
    expect(router.current()).toBe('/(auth)/invite?token=tok-1');
    router.push('/(auth)/sign-in');
    rerender(<RootLayoutView deps={deps} router={router} segments={['(auth)', 'sign-in']} />);
    deps.session.signIn({ accessToken: 'at', refreshToken: 'rt', accessExpiresAt: '2026-11-01T09:10:00Z' });
    rerender(<RootLayoutView deps={deps} router={router} segments={['(auth)', 'sign-in']} />);
    expect(router.current()).toBe('/(auth)/invite?token=tok-1');
  });
});

describe('the device reaches every screen (T-0528)', () => {
  it('a screen that reads the device renders under the root layout instead of throwing "DeviceProvider is missing"', async () => {
    const { RootLayoutView, createRootDeps } = await layoutFor('preview');
    const { useDevice } = await import('../src/device.ts');
    const deps = createRootDeps(config, { navigator: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X)' } });
    deps.session.signIn({ accessToken: 'at', refreshToken: 'rt', accessExpiresAt: '2026-11-01T09:10:00Z' });
    const Probe = () => <span data-testid="probe">{`${useDevice().info.platform}:${useDevice().info.osVersion}`}</span>;
    render(<RootLayoutView deps={deps} router={memoryRouter('/pay')} segments={['pay']}><Probe /></RootLayoutView>);
    expect(screen.getByTestId('probe').textContent).toBe('ios:17.4');
  });
});

describe('the authenticator follows the build, never the API', () => {
  const simOptions: PasskeyAuthenticationOptions = { challenge: 'c-from-the-simulator', rpId: 'kesher.example', timeoutMs: 60_000, userVerification: 'required', allowCredentials: [] };

  it('outside development, the platform WebAuthn runs even for the simulator options; no persona picker exists', async () => {
    for (const appEnv of ['preview', 'staging', 'prod', 'test']) {
      const { createRootDeps } = await layoutFor(appEnv);
      const get = vi.fn(async () => ({ toJSON: () => ({ id: 'platform-credential' }) }));
      vi.stubGlobal('PublicKeyCredential', { parseRequestOptionsFromJSON: (o: unknown) => o, parseCreationOptionsFromJSON: (o: unknown) => o });
      const deps = createRootDeps(config, { credentials: { get, create: vi.fn() } as unknown as CredentialsContainer, persona: 'dana' });
      expect(await deps.authenticator.get(simOptions)).toEqual({ id: 'platform-credential' });
      expect(get).toHaveBeenCalledOnce();
      expect(deps.personas).toBeUndefined();
    }
  });

  it('in development, the picked persona registers and signs in with the simulator; none picked is no passkey', async () => {
    const { createRootDeps } = await layoutFor('development');
    const deps = createRootDeps(config);
    await expect(deps.authenticator.get(simOptions)).rejects.toMatchObject({ code: 'NO_PASSKEY' }); // by code: each build's module graph is its own

    const sim = new AuthSimulator();
    deps.personas!.choose('noa');
    const reg: PasskeyRegistrationOptions = await sim.registrationOptions({ id: 'p1', name: 'Noa' });
    const credential = await sim.verifyRegistration(reg, (await deps.authenticator.create(reg)) as never);
    const challenge = await sim.authenticationOptions([credential]);
    expect(await sim.verifyAuthentication(challenge, (await deps.authenticator.get(challenge)) as never, credential)).toMatchObject({ verified: true });
  });

  it('in development, the bar on sign-in lists the seeded people and picks one', async () => {
    const { RootLayoutView, createRootDeps } = await layoutFor('development');
    const deps = createRootDeps(config, { persona: undefined });
    render(<RootLayoutView deps={deps} router={memoryRouter('/(auth)/sign-in')} segments={['(auth)', 'sign-in']} />);
    const dana = await screen.findByTestId('dev-persona-dana');
    expect(screen.getByTestId('dev-persona-noa')).toBeTruthy();
    expect(deps.personas!.current()).toBeUndefined();
    await act(async () => void fireEvent.click(dana));
    expect(deps.personas!.current()).toBe('dana');
  });
});

describe('money calls carry a fresh passkey step-up (T-0524)', () => {
  it('asks /auth/step-up for a challenge, signs it with this build\'s authenticator, and sends the token with the load', async () => {
    const { createRootDeps } = await layoutFor('preview');
    const calls: { path: string; body: unknown; stepUp: string | null }[] = [];
    const fetch = (async (url: URL, init?: RequestInit) => {
      const path = new URL(url).pathname;
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
      calls.push({ path, body, stepUp: new Headers(init?.headers).get('x-step-up') });
      const reply = path === '/v1/auth/step-up' ? (body?.['response'] ? { stepUpToken: 'su_1', expiresAt: '2026-11-01T09:05:00Z' } : { options: { challenge: 'c1' } }) : { id: 'l1', amount: { minor: '5000', currency: 'USD' }, state: 'settled' };
      return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof globalThis.fetch;
    const get = vi.fn(async () => ({ toJSON: () => ({ signed: 'c1' }) }));
    vi.stubGlobal('PublicKeyCredential', { parseRequestOptionsFromJSON: (o: unknown) => o, parseCreationOptionsFromJSON: (o: unknown) => o });
    const deps = createRootDeps({ apiUrl: 'http://localhost:3000/v1', appEnv: 'preview' }, { fetch, credentials: { get, create: vi.fn() } as unknown as CredentialsContainer });
    await deps.api.fund.createLoad({ memberPartyId: 'p1', amount: { minor: '5000', currency: 'USD' }, method: 'card', purseCurrency: 'USD' }, 'attempt-1');
    expect(calls.map((c) => c.path)).toEqual(['/v1/auth/step-up', '/v1/auth/step-up', '/v1/loads']);
    expect(calls[1]!.body).toEqual({ response: { signed: 'c1' } });
    expect(calls[2]!.stepUp).toBe('su_1');
    expect(get).toHaveBeenCalledOnce();
  });
});

describe('build config', () => {
  it('refuses plain http unless the host is localhost, and names the key, never the value', async () => {
    const { parseMobileConfig } = await import('../src/config.ts');
    expect(parseMobileConfig({ EXPO_PUBLIC_API_URL: 'http://localhost:3000/', EXPO_PUBLIC_APP_ENV: 'development' })).toEqual({ apiUrl: 'http://localhost:3000', appEnv: 'development' });
    expect(parseMobileConfig({ EXPO_PUBLIC_API_URL: 'https://api.kesher.example', EXPO_PUBLIC_APP_ENV: 'prod' }).apiUrl).toBe('https://api.kesher.example');
    expect(() => parseMobileConfig({ EXPO_PUBLIC_API_URL: 'http://api.secret-host.example', EXPO_PUBLIC_APP_ENV: 'prod' })).toThrow(/EXPO_PUBLIC_API_URL: must be https/);
    expect(() => parseMobileConfig({ EXPO_PUBLIC_API_URL: 'http://api.secret-host.example', EXPO_PUBLIC_APP_ENV: 'prod' })).not.toThrow(/secret-host/);
    expect(() => parseMobileConfig({ EXPO_PUBLIC_APP_ENV: 'nope' })).toThrow(/Missing configuration: EXPO_PUBLIC_API_URL[\s\S]*EXPO_PUBLIC_APP_ENV: must be one of/);
  });

  it('keeps one install id across launches, and still has one when storage throws', async () => {
    const { installId } = await import('../src/session.ts');
    const kept = new Map<string, string>();
    const store = { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v) };
    let n = 0;
    const id = installId(store, () => `id-${++n}`);
    expect(installId(store, () => `id-${++n}`)).toBe(id);
    const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect(installId(broken, () => 'fresh')).toBe('fresh');
    expect(memorySession(id).deviceId()).toBe(id);
  });
});
