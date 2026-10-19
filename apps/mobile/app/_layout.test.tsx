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
