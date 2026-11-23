// @vitest-environment jsdom
// T-0033: the root layout routes on the session, and the authenticator is chosen by the build alone: a
// development build signs as a picked demo persona, every other build uses the platform's WebAuthn even
// when the API sends the simulator's options. The config refuses plain http anywhere but localhost.
import { useEffect } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthSimulator, type PasskeyAuthenticationOptions, type PasskeyRegistrationOptions } from '@kesher/ports';
import type * as ReactNative from 'react-native';
import { memoryRouter } from '../src/navigation.ts';
import { memorySession } from '../src/session.ts';

// The phone's light or dark setting, which react-native-web reads once at load: a test sets it here instead.
const phone = vi.hoisted(() => ({ scheme: 'light' as 'light' | 'dark' }));
vi.mock('react-native', async (orig) => ({ ...(await orig<typeof ReactNative>()), useColorScheme: () => phone.scheme }));
vi.mock('expo-router', () => ({ Slot: () => null, useRouter: () => ({}), useSegments: () => [], useGlobalSearchParams: () => ({}), useRootNavigationState: () => ({ key: 'root' }) }));

const config = { apiUrl: 'http://localhost:3000', appEnv: 'development' as const };

/** The layout module as a bundle built with this EXPO_PUBLIC_APP_ENV sees it. */
async function layoutFor(appEnv: string) {
  vi.resetModules();
  vi.stubEnv('EXPO_PUBLIC_APP_ENV', appEnv);
  return import('./_layout.tsx');
}

// The layout pulls in react-native-web and every screen it reaches. Transforming that graph the first time takes a
// second here and five on a busy CI runner, which was charged to whichever test imported it first and timed it out.
// Warm it once with its own budget: each test still re-imports it fresh (resetModules), from the transform cache.
beforeAll(async () => {
  await import('./_layout.tsx');
}, 60_000);

/** A signed-in member's stored appearance is read before the app shows (T-1021): these tests have no API to ask, so it answers `system`. */
function withStoredAppearance<D extends { api: { preferences: object } }>(deps: D): D {
  deps.api = { ...deps.api, preferences: { get: async () => ({ receiveCurrency: 'as_sent', theme: 'system' }), set: async () => ({ receiveCurrency: 'as_sent', theme: 'system' }) } };
  return deps;
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
    // The terms to accept (T-0062) are read signed in, so the signed-in member stays on that auth screen.
    expect(guard(true, ['(auth)', 'consent'])).toBeUndefined();
    expect(guard(true, ['(auth)', 'sign-in'])).toBe('/(tabs)/home');
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
    // A funder's invite (T-0309) comes back the same way and keeps the signed-in member.
    expect(resumable(['(auth)', 'join'], { token: 'tok/2' })).toBe('/(auth)/join?token=tok%2F2');
    expect([guard(false, ['(auth)', 'join']), guard(true, ['(auth)', 'join'])]).toEqual([undefined, undefined]);
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

describe('a consent that is owed keeps the member on the consent screen (T-0062)', () => {
  it('guard sends every route but the consent screen there, and releases the member after acceptance', async () => {
    const { guard } = await layoutFor('preview');
    const consent = (returnTo: string) => `/(auth)/consent?returnTo=${encodeURIComponent(returnTo)}`;
    expect(guard(true, ['(tabs)', 'home'], undefined, true)).toBe(consent('/(tabs)/home'));
    expect(guard(true, ['card'], undefined, true)).toBe(consent('/card'));
    expect(guard(true, ['pay', 'confirm'], undefined, true)).toBe(consent('/pay/confirm'));
    expect(guard(true, ['fund', 'add-money'], undefined, true)).toBe(consent('/fund/add-money'));
    expect(guard(true, ['settings', 'legal'], undefined, true)).toBe(consent('/settings/legal'));
    expect(guard(true, ['(auth)', 'sign-in'], '/connect/x', true)).toBe(consent('/connect/x'));
    expect(guard(true, ['(auth)', 'invite'], undefined, true)).toBe(consent('/'));
    expect(guard(true, ['(auth)', 'consent'], undefined, true)).toBeUndefined();
    // After acceptance the same routes are reachable.
    expect(guard(true, ['(tabs)', 'home'], undefined, false)).toBeUndefined();
    expect(guard(true, ['pay', 'confirm'], undefined, false)).toBeUndefined();
    // Signed out, the consent screen is not a place to stay (sign out lands on sign-in).
    expect(guard(false, ['(auth)', 'consent'])).toBe('/(auth)/sign-in');
  });

  it('the root layout holds the member there while the gate is set, and lets them go back to returnTo once it is cleared', async () => {
    const { RootLayoutView, createRootDeps } = await layoutFor('preview');
    const deps = createRootDeps(config);
    deps.session.signIn({ accessToken: 'at', refreshToken: 'rt', accessExpiresAt: '2026-11-01T09:10:00Z' });
    const router = memoryRouter('/card');
    const { rerender } = render(<RootLayoutView deps={deps} router={router} segments={['card']} />);
    expect(router.current()).toBe('/card');
    act(() => deps.consent.set({ pending: true }));
    expect(router.current()).toBe('/(auth)/consent?returnTo=%2Fcard');
    router.push('/pay');
    rerender(<RootLayoutView deps={deps} router={router} segments={['pay']} />);
    expect(router.current()).toBe('/(auth)/consent?returnTo=%2Fpay');
    // On the consent screen it stays, then the accepted model clears the gate and replaces to returnTo.
    rerender(<RootLayoutView deps={deps} router={router} segments={['(auth)', 'consent']} />);
    expect(router.current()).toBe('/(auth)/consent?returnTo=%2Fpay');
    act(() => deps.consent.set({ pending: false }));
    router.replace('/pay');
    rerender(<RootLayoutView deps={deps} router={router} segments={['pay']} />);
    expect(router.current()).toBe('/pay');
  });
});

describe('the device reaches every screen (T-0528)', () => {
  it('a screen that reads the device renders under the root layout instead of throwing "DeviceProvider is missing"', async () => {
    const { RootLayoutView, createRootDeps } = await layoutFor('preview');
    const { useDevice } = await import('../src/device.ts');
    const deps = withStoredAppearance(createRootDeps(config, { navigator: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X)' } }));
    deps.session.signIn({ accessToken: 'at', refreshToken: 'rt', accessExpiresAt: '2026-11-01T09:10:00Z' });
    const Probe = () => <span data-testid="probe">{`${useDevice().info.platform}:${useDevice().info.osVersion}`}</span>;
    render(<RootLayoutView deps={deps} router={memoryRouter('/pay')} segments={['pay']}><Probe /></RootLayoutView>);
    await act(async () => undefined); // the stored appearance is read first (T-1021)
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

describe('the tab bar (T-0673)', () => {
  const signedIn = (deps: { session: { signIn(t: { accessToken: string; refreshToken: string; accessExpiresAt: string }): void } }) => deps.session.signIn({ accessToken: 'at', refreshToken: 'rt', accessExpiresAt: '2026-11-01T09:10:00Z' });

  it('five tabs in order over the existing routes; the active one follows the route', async () => {
    const { TABS, activeTab } = await import('../src/navigation.ts');
    expect(TABS.map((t) => [t.key, t.href])).toEqual([
      ['home', '/(tabs)/home'],
      ['card', '/card'],
      ['club', '/club'],
      ['pay', '/pay'],
      ['help', '/help'],
    ]);
    expect([activeTab(['(tabs)', 'home']), activeTab(['card', 'lost']), activeTab(['club', 'esim']), activeTab(['pay', 'recipient']), activeTab(['help'])]).toEqual(['home', 'card', 'club', 'pay', 'help']);
    expect([activeTab(['fund', 'add-money']), activeTab(['(auth)', 'sign-in']), activeTab([]), activeTab(['wallet', 'transaction'])]).toEqual([undefined, undefined, undefined, undefined]);
  });

  it('shows for a signed-in member on a tab screen, never signed out or on a screen outside the tabs', async () => {
    const { RootLayoutView, createRootDeps } = await layoutFor('preview');
    const deps = withStoredAppearance(createRootDeps(config));
    const { rerender } = render(<RootLayoutView deps={deps} router={memoryRouter('/pay')} segments={['pay']} />);
    expect(screen.queryByTestId('tab-bar')).toBeNull();
    signedIn(deps);
    rerender(<RootLayoutView deps={deps} router={memoryRouter('/pay')} segments={['pay']} />);
    await act(async () => undefined);
    expect(screen.getByTestId('tab-bar')).toBeTruthy();
    expect(screen.getAllByRole('tab').map((e) => [e.textContent, e.getAttribute('aria-selected')])).toEqual([
      ['⌂Home', 'false'],
      ['▭Card', 'false'],
      ['◇Club', 'false'],
      ['↗Pay', 'true'],
      ['?Help', 'false'],
    ]);
    rerender(<RootLayoutView deps={deps} router={memoryRouter('/fund/add-money')} segments={['fund', 'add-money']} />);
    expect(screen.queryByTestId('tab-bar')).toBeNull();
  });

  it('selecting a tab replaces the route with that tab\'s root, and the screen is still rendered above the bar', async () => {
    const { RootLayoutView, createRootDeps } = await layoutFor('preview');
    const deps = withStoredAppearance(createRootDeps(config));
    signedIn(deps);
    const router = memoryRouter('/(tabs)/home');
    render(
      <RootLayoutView deps={deps} router={router} segments={['(tabs)', 'home']}>
        <span data-testid="screen">screen</span>
      </RootLayoutView>,
    );
    await act(async () => undefined);
    expect(screen.getByTestId('screen')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('tab')[1]!);
    expect(router.current()).toBe('/card');
    fireEvent.click(screen.getAllByRole('tab')[0]!);
    expect(router.current()).toBe('/(tabs)/home');
  });

  it('in Hebrew the labels are Hebrew and the row direction is right to left', async () => {
    const { RootLayoutView, createRootDeps } = await layoutFor('preview');
    const deps = withStoredAppearance({ ...createRootDeps(config, { language: 'he-IL' }) });
    signedIn(deps);
    render(<RootLayoutView deps={deps} router={memoryRouter('/help')} segments={['help']} />);
    await act(async () => undefined);
    expect(getComputedStyle(screen.getByTestId('tab-bar')).direction).toBe('rtl');
    expect(screen.getAllByRole('tab').map((e) => e.textContent).join('|')).toMatch(/בית.*עזרה/);
  });
});


describe('the member\'s appearance reaches every screen (T-1021, TST-UX-003)', () => {
  const signIn = (deps: { session: { signIn(t: { accessToken: string; refreshToken: string; accessExpiresAt: string }): void } }) => deps.session.signIn({ accessToken: 'at', refreshToken: 'rt', accessExpiresAt: '2026-11-01T09:10:00Z' });
  type Layout = Awaited<ReturnType<typeof layoutFor>>;
  type Deps = ReturnType<Layout['createRootDeps']>;
  const stored = (deps: Deps, get: () => Promise<{ receiveCurrency: 'as_sent'; theme: 'system' | 'light' | 'dark' }>) => {
    deps.api = { ...deps.api, preferences: { get, set: async () => get() } };
  };
  const answers = (theme: 'system' | 'light' | 'dark') => async () => ({ receiveCurrency: 'as_sent' as const, theme });
  beforeEach(() => void (phone.scheme = 'light'));
  const systemScheme = (scheme: 'light' | 'dark') => void (phone.scheme = scheme);
  const probes = async () => {
    const { useThemeMode } = await import('../src/theme.ts');
    const { useTheme } = await import('../src/theme.ts');
    return function Probe() {
      const bg = useTheme().color.bg.canvas;
      return <span data-testid="probe" data-bg={bg}>{useThemeMode()}</span>;
    };
  };
  const mode = () => screen.getByTestId('probe').textContent;

  it('the stored value beats the system one: dark over a light system, light over a dark one, system follows the phone', async () => {
    const { RootLayoutView, createRootDeps } = await layoutFor('preview');
    const Probe = await probes();
    for (const [theme, phone, expected] of [['dark', 'light', 'dark'], ['light', 'dark', 'light'], ['system', 'dark', 'dark'], ['system', 'light', 'light']] as const) {
      systemScheme(phone);
      const deps = createRootDeps(config);
      stored(deps, answers(theme));
      signIn(deps);
      render(<RootLayoutView deps={deps} router={memoryRouter('/')} segments={['(tabs)', 'home']}><Probe /></RootLayoutView>);
      await act(async () => undefined);
      expect([theme, phone, mode()]).toEqual([theme, phone, expected]);
      cleanup();
    }
  });

  it('a resolving get shows no frame in the wrong mode: held and system-themed until it answers, then the stored mode at once', async () => {
    const { RootLayoutView, createRootDeps } = await layoutFor('preview');
    const Probe = await probes();
    systemScheme('light');
    const deps = createRootDeps(config);
    let answer!: (p: { receiveCurrency: 'as_sent'; theme: 'dark' }) => void;
    stored(deps, () => new Promise((r) => (answer = r as typeof answer)));
    signIn(deps);
    render(<RootLayoutView deps={deps} router={memoryRouter('/')} segments={['(tabs)', 'home']}><Probe /></RootLayoutView>);
    expect(screen.getByTestId('appearance-held')).toBeTruthy();
    // The screen stays mounted under the frame, in the system mode, hidden from screen readers and inert.
    expect(mode()).toBe('light');
    const hidden = screen.getByTestId('probe').closest('[aria-hidden="true"]') as HTMLElement;
    expect(hidden).toBeTruthy();
    expect(getComputedStyle(hidden).opacity).toBe('0');
    expect(getComputedStyle(hidden).pointerEvents).toBe('none');
    await act(async () => answer({ receiveCurrency: 'as_sent', theme: 'dark' }));
    expect(screen.queryByTestId('appearance-held')).toBeNull();
    expect(screen.getByTestId('probe').closest('[aria-hidden="true"]')).toBeNull();
    expect(mode()).toBe('dark');
    expect(deps.appearance.store.get().theme).toBe('dark');
  });

  it('the held frame is the loading skeleton on the SYSTEM canvas, even for a member who stored the other mode', async () => {
    const { RootLayoutView, createRootDeps } = await layoutFor('preview');
    const { theme } = await import('@kesher/tokens');
    systemScheme('dark');
    const deps = createRootDeps(config);
    deps.appearance.store.patch({ theme: 'light' }); // a stale value must not paint
    stored(deps, () => new Promise(() => undefined));
    signIn(deps);
    render(<RootLayoutView deps={deps} router={memoryRouter('/')} segments={['(tabs)', 'home']} />);
    const held = screen.getByTestId('appearance-held');
    expect(getComputedStyle(held).backgroundColor.replace(/\s/g, '')).toBe(hex(theme.dark.color.bg.canvas));
    expect(screen.getByTestId('skeleton')).toBeTruthy();
  });

  it('a get that never resolves: the app renders after 1.5 s in the system mode and stays there', async () => {
    vi.useFakeTimers();
    try {
      const { RootLayoutView, createRootDeps, APPEARANCE_HOLD_MS } = await layoutFor('preview');
      const Probe = await probes();
      systemScheme('dark');
      const deps = createRootDeps(config);
      stored(deps, () => new Promise(() => undefined));
      signIn(deps);
      render(<RootLayoutView deps={deps} router={memoryRouter('/')} segments={['(tabs)', 'home']}><Probe /></RootLayoutView>);
      expect(APPEARANCE_HOLD_MS).toBe(1500);
      await act(async () => void vi.advanceTimersByTime(1499));
      expect(screen.getByTestId('appearance-held')).toBeTruthy();
      await act(async () => void vi.advanceTimersByTime(1));
      expect(screen.queryByTestId('appearance-held')).toBeNull();
      expect(mode()).toBe('dark'); // the system's
      await act(async () => void vi.advanceTimersByTime(60_000));
      expect(mode()).toBe('dark');
      expect(deps.appearance.store.get().theme).toBe('system');
    } finally {
      vi.useRealTimers();
    }
  });

  it('the screen under the held frame is not unmounted and remounted: the router\'s Slot keeps its place', async () => {
    const { RootLayoutView, createRootDeps } = await layoutFor('preview');
    systemScheme('light');
    const deps = createRootDeps(config);
    let answer!: (p: { receiveCurrency: 'as_sent'; theme: 'dark' }) => void;
    stored(deps, () => new Promise((r) => (answer = r as typeof answer)));
    signIn(deps);
    const lifecycle: string[] = [];
    const Slotlike = () => {
      useEffect(() => {
        lifecycle.push('mount');
        return () => void lifecycle.push('unmount');
      }, []);
      return null;
    };
    render(<RootLayoutView deps={deps} router={memoryRouter('/')} segments={['(tabs)', 'home']}><Slotlike /></RootLayoutView>);
    await act(async () => answer({ receiveCurrency: 'as_sent', theme: 'dark' }));
    expect(lifecycle).toEqual(['mount']);
  });

  it('a read that throws at once, a double with no preferences, and an answer with no theme all render in the system mode', async () => {
    const { RootLayoutView, createRootDeps } = await layoutFor('preview');
    const Probe = await probes();
    systemScheme('dark');
    const cases: Record<string, (deps: Deps) => void> = {
      'throws at once': (deps) => stored(deps, () => { throw new Error('stub'); }),
      'no preferences': (deps) => void (deps.api = { ...deps.api, preferences: undefined as never }),
      'no theme': (deps) => stored(deps, (async () => ({ receiveCurrency: 'as_sent' })) as never),
      'nothing at all': (deps) => stored(deps, (async () => undefined) as never),
      'not a theme': (deps) => stored(deps, (async () => ({ receiveCurrency: 'as_sent', theme: 'sepia' })) as never),
    };
    for (const [name, arrange] of Object.entries(cases)) {
      const deps = createRootDeps(config);
      arrange(deps);
      signIn(deps);
      render(<RootLayoutView deps={deps} router={memoryRouter('/')} segments={['(tabs)', 'home']}><Probe /></RootLayoutView>);
      await act(async () => undefined);
      expect([name, screen.queryByTestId('appearance-held')]).toEqual([name, null]);
      expect([name, mode()]).toEqual([name, 'dark']);
      expect([name, deps.appearance.store.get().theme]).toEqual([name, 'system']);
      cleanup();
    }
  });

  it('a late read does not overwrite a choice the member already made and saved', async () => {
    vi.useFakeTimers();
    try {
      const { RootLayoutView, createRootDeps } = await layoutFor('preview');
      const { createAppearanceModel } = await import('./settings/appearance.model.ts');
      const Probe = await probes();
      systemScheme('light');
      const deps = createRootDeps(config);
      let answer!: (p: { receiveCurrency: 'as_sent'; theme: 'light' }) => void;
      stored(deps, () => new Promise((r) => (answer = r as typeof answer)));
      signIn(deps);
      render(<RootLayoutView deps={deps} router={memoryRouter('/')} segments={['(tabs)', 'home']}><Probe /></RootLayoutView>);
      await act(async () => void vi.advanceTimersByTime(1500));
      const model = createAppearanceModel({ preferences: { get: async () => ({ receiveCurrency: 'as_sent', theme: 'system' }), set: async (p) => ({ receiveCurrency: 'as_sent', theme: 'system', ...p }) }, shared: deps.appearance });
      await act(async () => model.choose('dark'));
      expect(mode()).toBe('dark');
      await act(async () => answer({ receiveCurrency: 'as_sent', theme: 'light' })); // the stale read, from before the choice
      expect(mode()).toBe('dark');
      expect(deps.appearance.store.get().theme).toBe('dark');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a save that answers, or is refused, after sign-out leaves the shared store at system for the next member', async () => {
    for (const outcome of ['answers', 'refused'] as const) {
      const { RootLayoutView, createRootDeps } = await layoutFor('preview');
      const { createAppearanceModel } = await import('./settings/appearance.model.ts');
      const Probe = await probes();
      systemScheme('light');
      const deps = createRootDeps(config);
      stored(deps, answers('light'));
      signIn(deps);
      const router = memoryRouter('/');
      const view = (segments: string[]) => <RootLayoutView deps={deps} router={router} segments={segments}><Probe /></RootLayoutView>;
      const { rerender } = render(view(['(tabs)', 'home']));
      await act(async () => undefined);
      let settle!: () => void;
      const model = createAppearanceModel({
        preferences: {
          get: async () => ({ receiveCurrency: 'as_sent', theme: 'light' }),
          set: (p) => new Promise((resolve, reject) => (settle = () => (outcome === 'answers' ? resolve({ receiveCurrency: 'as_sent', theme: p.theme ?? 'system' }) : reject(new Error('refused'))))),
        },
        shared: deps.appearance,
      });
      await act(async () => model.load());
      let saving!: Promise<void>;
      act(() => void (saving = model.choose('dark')));
      expect(mode()).toBe('dark');
      deps.session.signOut();
      rerender(view(['(auth)', 'sign-in']));
      expect(mode()).toBe('light');
      await act(async () => {
        settle();
        await saving;
      });
      expect([outcome, deps.appearance.store.get().theme]).toEqual([outcome, 'system']);
      expect([outcome, mode()]).toEqual([outcome, 'light']);
      // The next member starts from system.
      stored(deps, answers('system'));
      signIn(deps);
      rerender(view(['(tabs)', 'home']));
      expect(mode()).toBe('light');
      await act(async () => undefined);
      expect([outcome, deps.appearance.store.get().theme]).toEqual([outcome, 'system']);
      cleanup();
    }
  });

  it('the sign-in screen never paints a frame in the previous member\'s mode on sign-out', async () => {
    const { RootLayoutView, createRootDeps } = await layoutFor('preview');
    const { useThemeMode } = await import('../src/theme.ts');
    systemScheme('light');
    const deps = createRootDeps(config);
    stored(deps, answers('dark'));
    signIn(deps);
    const router = memoryRouter('/');
    const frames: string[] = [];
    const Probe = () => {
      frames.push(useThemeMode());
      return null;
    };
    const view = (segments: string[]) => <RootLayoutView deps={deps} router={router} segments={segments}><Probe /></RootLayoutView>;
    const { rerender } = render(view(['(tabs)', 'home']));
    await act(async () => undefined);
    expect(frames[frames.length - 1]).toBe('dark');
    frames.length = 0;
    deps.session.signOut();
    rerender(view(['(auth)', 'sign-in']));
    expect(frames.length).toBeGreaterThan(0);
    expect(frames).not.toContain('dark');
  });

  it('no timer is left behind after sign-out or unmount', async () => {
    vi.useFakeTimers();
    try {
      const { RootLayoutView, createRootDeps } = await layoutFor('preview');
      systemScheme('light');
      const deps = createRootDeps(config);
      stored(deps, () => new Promise(() => undefined));
      const router = memoryRouter('/');
      const view = (segments: string[]) => <RootLayoutView deps={deps} router={router} segments={segments} />;
      const { rerender, unmount } = render(view(['(auth)', 'sign-in']));
      expect(vi.getTimerCount()).toBe(0);
      signIn(deps);
      rerender(view(['(tabs)', 'home']));
      expect(vi.getTimerCount()).toBe(1);
      deps.session.signOut();
      rerender(view(['(auth)', 'sign-in']));
      expect(vi.getTimerCount()).toBe(0);
      signIn(deps);
      rerender(view(['(tabs)', 'home']));
      expect(vi.getTimerCount()).toBe(1);
      unmount();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a get that fails renders at once in the system mode', async () => {
    const { RootLayoutView, createRootDeps } = await layoutFor('preview');
    const Probe = await probes();
    systemScheme('dark');
    const deps = createRootDeps(config);
    stored(deps, () => Promise.reject(new Error('down')));
    signIn(deps);
    render(<RootLayoutView deps={deps} router={memoryRouter('/')} segments={['(tabs)', 'home']}><Probe /></RootLayoutView>);
    await act(async () => undefined);
    expect(screen.queryByTestId('appearance-held')).toBeNull();
    expect(mode()).toBe('dark');
  });

  it('a get that resolves after the cap switches once to the stored mode, with no flicker back', async () => {
    vi.useFakeTimers();
    try {
      const { RootLayoutView, createRootDeps } = await layoutFor('preview');
      const { useThemeMode } = await import('../src/theme.ts');
      systemScheme('light');
      const deps = createRootDeps(config);
      let answer!: (p: { receiveCurrency: 'as_sent'; theme: 'dark' }) => void;
      stored(deps, () => new Promise((r) => (answer = r as typeof answer)));
      signIn(deps);
      const modes: string[] = [];
      const Probe = () => {
        const m = useThemeMode();
        if (modes[modes.length - 1] !== m) modes.push(m);
        return <span data-testid="probe">{m}</span>;
      };
      render(<RootLayoutView deps={deps} router={memoryRouter('/')} segments={['(tabs)', 'home']}><Probe /></RootLayoutView>);
      await act(async () => void vi.advanceTimersByTime(1500));
      expect(mode()).toBe('light');
      await act(async () => answer({ receiveCurrency: 'as_sent', theme: 'dark' }));
      expect(mode()).toBe('dark');
      await act(async () => void vi.advanceTimersByTime(10_000));
      expect(modes).toEqual(['light', 'dark']);
      expect(deps.appearance.store.get().theme).toBe('dark');
    } finally {
      vi.useRealTimers();
    }
  });

  it('is read once per sign-in, and signing out resets it so the next member never sees the last one\'s mode', async () => {
    const { RootLayoutView, createRootDeps } = await layoutFor('preview');
    const Probe = await probes();
    systemScheme('light');
    const deps = createRootDeps(config);
    const get = vi.fn(answers('dark'));
    stored(deps, get);
    const router = memoryRouter('/');
    const view = (segments: string[]) => <RootLayoutView deps={deps} router={router} segments={segments}><Probe /></RootLayoutView>;
    const { rerender } = render(view(['(auth)', 'sign-in']));
    expect(get).not.toHaveBeenCalled(); // signed out: no account, no preference
    expect(mode()).toBe('light');
    signIn(deps);
    rerender(view(['(tabs)', 'home']));
    await act(async () => undefined);
    rerender(view(['(tabs)', 'home']));
    expect(get).toHaveBeenCalledTimes(1);
    expect(mode()).toBe('dark');
    deps.session.signOut();
    rerender(view(['(auth)', 'sign-in']));
    expect(deps.appearance.store.get().theme).toBe('system');
    expect(mode()).toBe('light');
    // The next member signs in: held again, then their own stored mode.
    stored(deps, answers('light'));
    systemScheme('dark');
    signIn(deps);
    rerender(view(['(tabs)', 'home']));
    expect(screen.getByTestId('appearance-held')).toBeTruthy();
    await act(async () => undefined);
    expect(mode()).toBe('light');
  });

  it('a late answer for a member who has signed out is dropped', async () => {
    const { RootLayoutView, createRootDeps } = await layoutFor('preview');
    const deps = createRootDeps(config);
    let answer!: (p: { receiveCurrency: 'as_sent'; theme: 'dark' }) => void;
    stored(deps, () => new Promise((r) => (answer = r as typeof answer)));
    signIn(deps);
    const router = memoryRouter('/');
    const { rerender } = render(<RootLayoutView deps={deps} router={router} segments={['(tabs)', 'home']} />);
    deps.session.signOut();
    rerender(<RootLayoutView deps={deps} router={router} segments={['(auth)', 'sign-in']} />);
    await act(async () => answer({ receiveCurrency: 'as_sent', theme: 'dark' }));
    expect(deps.appearance.store.get().theme).toBe('system');
  });

  it('signed-out screens follow the system, and the override reaches the chrome above the screen too (the tab bar, the persona bar)', async () => {
    const { RootLayoutView, createRootDeps } = await layoutFor('development');
    systemScheme('dark');
    const signedOut = createRootDeps(config);
    signedOut.appearance.store.patch({ theme: 'light' }); // not reachable signed out in practice: even so the member is reset
    const Probe = await probes();
    const { unmount } = render(<RootLayoutView deps={signedOut} router={memoryRouter('/')} segments={['(auth)', 'sign-in']}><Probe /></RootLayoutView>);
    await act(async () => undefined);
    expect(mode()).toBe('dark');
    unmount();

    const deps = createRootDeps(config);
    stored(deps, answers('light'));
    signIn(deps);
    render(<RootLayoutView deps={deps} router={memoryRouter('/')} segments={['(tabs)', 'home']}><Probe /></RootLayoutView>);
    await act(async () => undefined);
    expect(mode()).toBe('light');
    const { theme } = await import('@kesher/tokens');
    expect(getComputedStyle(screen.getByTestId('tab-bar')).backgroundColor.replace(/\s/g, '')).toBe(hex(theme.light.color.bg.surface));
  });

  it('Home has an Appearance row beside the receiving-currency one, and it opens /settings/appearance', async () => {
    const { HomeView } = await import('./(tabs)/home.tsx');
    const { createHomeModel } = await import('./(tabs)/home.model.ts');
    const { RouterProvider } = await import('../src/navigation.ts');
    const { LocaleProvider } = await import('../src/i18n.ts');
    const router = memoryRouter('/(tabs)/home');
    const none = async () => ({ items: [] });
    const model = createHomeModel({
      wallet: { listAccounts: none, listTransactions: none } as never,
      kyc: { status: async () => ({ status: 'approved', approvedTier: 'T2' }) } as never,
      cards: { listCards: none } as never,
      status: { get: async () => ({ capabilities: [] }) } as never,
      proposals: { list: none } as never,
      displayName: { get: async () => undefined } as never,
      router,
      now: () => new Date('2026-11-23T09:00:00Z'),
      locale: 'en',
    });
    render(<LocaleProvider value="en"><RouterProvider value={router}><HomeView model={model} /></RouterProvider></LocaleProvider>);
    await act(async () => undefined);
    expect(screen.getByTestId('home-appearance').textContent).toMatch(/^Appearance/);
    const rows = Array.from(screen.getByTestId('home-settings').querySelectorAll('[data-testid]')).map((e) => e.getAttribute('data-testid'));
    expect(rows.indexOf('home-appearance')).toBe(rows.indexOf('home-receive-in') + 1);
    fireEvent.click(screen.getByTestId('home-appearance'));
    expect(router.current()).toBe('/settings/appearance');
  });

  it('the Appearance screen reads its model over the shared store and renders the three options with the current one selected', async () => {
    const { AppearanceView } = await import('./settings/appearance.tsx');
    const { createAppearanceModel, createSharedAppearance } = await import('./settings/appearance.model.ts');
    const { LocaleProvider } = await import('../src/i18n.ts');
    const shared = createSharedAppearance();
    const model = createAppearanceModel({ preferences: { get: async () => ({ receiveCurrency: 'as_sent', theme: 'dark' }), set: async (p) => ({ receiveCurrency: 'as_sent', theme: 'dark', ...p }) }, shared });
    render(<LocaleProvider value="en"><AppearanceView model={model} /></LocaleProvider>);
    await act(async () => undefined);
    expect(['system', 'light', 'dark'].map((v) => screen.getByTestId(`appearance-${v}`).textContent)).toEqual(['SystemFollow the light or dark setting of your phone.›', 'Light›', 'Dark✓']);
    await act(async () => void fireEvent.click(screen.getByTestId('appearance-light')));
    expect(screen.getByTestId('appearance-light').textContent).toBe('Light✓');
    expect(shared.store.get().theme).toBe('light');
    expect(screen.getByTestId('appearance-notice')).toBeTruthy();
  });
});

/** `rgb(r, g, b)` as the DOM reports it, from a `#RRGGBB` token. */
function hex(h: string): string {
  const n = parseInt(h.slice(1, 7), 16);
  return `rgb(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255})`;
}
