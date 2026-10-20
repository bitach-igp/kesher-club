// Root layout (T-0033): binds the seams every screen reads (README "Shape") and keeps the signed-out
// member on sign-in and the signed-in one off it. `RootLayoutView` takes its deps and the current route
// segments, so tests render it without Expo; the default export binds expo-router, the SDK client
// against EXPO_PUBLIC_API_URL, react-native's Linking and the authenticator for this build.
//
// Which authenticator is decided by the build alone: `process.env.EXPO_PUBLIC_APP_ENV` is spelled out,
// so the bundler inlines it and drops the development branch, the demo personas and their seeded
// passkeys from every other bundle. Nothing the API answers can switch it.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Linking, Pressable, View } from 'react-native';
import { Slot, useGlobalSearchParams, useRootNavigationState, useRouter as useExpoRouter, useSegments, type Href as ExpoHref } from 'expo-router';
import { uuidv7 } from '@kesher/domain';
import { createClient } from '@kesher/sdk';
import { ApiProvider, sdkApi, type Api } from '../src/api.ts';
import { Txt } from '../src/components/index.ts';
import { buildEnv, parseMobileConfig, type MobileConfig } from '../src/config.ts';
import { LocaleProvider, t, useLocale, type Locale } from '../src/i18n.ts';
import { OpenerProvider, type Opener } from '../src/linking.ts';
import { ParamsProvider, RouterProvider, type Router } from '../src/navigation.ts';
import { AuthenticatorProvider, seededAuthenticator, webAuthnAuthenticator, type Authenticator, type SeededDevice } from '../src/passkeys.ts';
import { installId, memorySession, SessionProvider, type Session } from '../src/session.ts';
import { useTheme } from '../src/theme.ts';

export const SIGN_IN_HREF = '/(auth)/sign-in';
export const HOME_HREF = '/(tabs)/home';

export interface DemoPersona {
  key: string;
  name: string;
  market: string;
}

/** Development builds only: the seeded people (T-0032) and which one signs in. */
export interface PersonaPicker {
  load(): Promise<readonly DemoPersona[]>;
  current(): string | undefined;
  choose(key: string): void;
}

export interface RootDeps {
  api: Api;
  session: Session;
  authenticator: Authenticator;
  opener: Opener;
  locale: Locale;
  personas?: PersonaPicker | undefined;
}

/** Where the member belongs for these segments, or undefined to stay. */
export function guard(signedIn: boolean, segments: readonly string[]): string | undefined {
  const inAuth = segments[0] === '(auth)';
  if (!signedIn) return inAuth ? undefined : SIGN_IN_HREF;
  const nowhere = segments.length === 0 || segments[0]!.startsWith('+') || segments[0]!.startsWith('[');
  return inAuth || nowhere ? HOME_HREF : undefined;
}

export function RootLayoutView({ deps, router, segments, params = {}, ready = true, children }: { deps: RootDeps; router: Router; segments: readonly string[]; params?: Readonly<Record<string, string | undefined>>; ready?: boolean; children?: ReactNode }) {
  const target = guard(deps.session.accessToken() !== undefined, segments);
  // expo-router refuses to navigate before its root navigator has mounted.
  useEffect(() => {
    if (ready && target) router.replace(target);
  }, [ready, target, router]);
  return (
    <LocaleProvider value={deps.locale}>
      <ApiProvider value={deps.api}>
        <SessionProvider value={deps.session}>
          <AuthenticatorProvider value={deps.authenticator}>
            <OpenerProvider value={deps.opener}>
              <RouterProvider value={router}>
                <ParamsProvider value={params}>
                  {deps.personas && segments[0] === '(auth)' ? <PersonaBar picker={deps.personas} /> : null}
                  {children}
                </ParamsProvider>
              </RouterProvider>
            </OpenerProvider>
          </AuthenticatorProvider>
        </SessionProvider>
      </ApiProvider>
    </LocaleProvider>
  );
}

/** The development build's strip above sign-in: which seeded person the passkey belongs to. */
function PersonaBar({ picker }: { picker: PersonaPicker }) {
  const th = useTheme();
  const locale = useLocale();
  const [people, setPeople] = useState<readonly DemoPersona[]>([]);
  const [current, setCurrent] = useState(picker.current());
  useEffect(() => {
    let live = true;
    void picker.load().then((p) => live && setPeople(p));
    return () => void (live = false);
  }, [picker]);
  return (
    <View testID="dev-persona-bar" style={{ padding: th.space[3], gap: th.space[2], backgroundColor: th.color.bg.surface, borderBottomWidth: th.borderWidth.default, borderBottomColor: th.color.border.strong }}>
      <Txt variant="caption" tone="secondary">{t(current ? 'dev.persona.label' : 'dev.persona.none', locale)}</Txt>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: th.space[2] }}>
        {people.map((p) => (
          <Pressable
            key={p.key}
            testID={`dev-persona-${p.key}`}
            accessibilityRole="radio"
            accessibilityState={{ selected: p.key === current }}
            onPress={() => {
              picker.choose(p.key);
              setCurrent(p.key);
            }}
            style={{ paddingHorizontal: th.space[3], paddingVertical: th.space[2], borderRadius: th.radius.md, backgroundColor: p.key === current ? th.color.action.primarySubtle : 'transparent', borderWidth: th.borderWidth.default, borderColor: p.key === current ? th.color.action.primary : th.color.border.strong }}
          >
            <Txt variant="caption">{`${p.name} · ${p.market}`}</Txt>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

/** The development build signs as a picked persona; every other build uses the platform's passkeys. */
export function chooseAuthenticator(persona: () => string | undefined, credentials?: CredentialsContainer): Authenticator {
  if (process.env.EXPO_PUBLIC_APP_ENV === 'development') {
    const devices = new Map<string, Promise<SeededDevice>>();
    return seededAuthenticator(async () => {
      const key = persona();
      if (!key) return undefined;
      if (!devices.has(key)) devices.set(key, import('@kesher/ports/seeded').then(({ SeededPasskey }) => SeededPasskey.fromSeed(key) as Promise<SeededDevice>));
      return devices.get(key);
    });
  }
  return webAuthnAuthenticator(credentials);
}

const loadPersonas: (() => Promise<readonly DemoPersona[]>) | undefined =
  process.env.EXPO_PUBLIC_APP_ENV === 'development' ? () => import('@kesher/demo/personas').then((m) => m.PERSONAS.map(({ key, name, market }) => ({ key, name, market }))) : undefined;

export interface Platform {
  fetch?: typeof fetch;
  credentials?: CredentialsContainer | undefined;
  storage?: Storage | undefined;
  /** `?persona=` on web: a recording opens the app already signed-in-ready as someone. */
  persona?: string | undefined;
  language?: string | undefined;
}

export function createRootDeps(config: MobileConfig, platform: Platform = {}): RootDeps {
  const session = memorySession(installId(platform.storage, () => uuidv7()));
  let persona = platform.persona;
  const authenticator = chooseAuthenticator(() => persona, platform.credentials);
  // Every money call carries a fresh passkey step-up (REQ-AUTH-006): the client asks for one just before
  // it sends, and this build's authenticator signs the challenge.
  const client: ReturnType<typeof createClient> = createClient({
    baseUrl: config.apiUrl,
    getAccessToken: () => session.accessToken() ?? session.otpSession(),
    getStepUpToken: async () => {
      const { options } = await client.post('/auth/step-up', { body: {} });
      const response = (await authenticator.get(options)) as Record<string, never>;
      const { stepUpToken } = await client.post('/auth/step-up', { body: { response } });
      if (!stepUpToken) throw new Error('Step-up returned no token');
      return stepUpToken;
    },
    ...(platform.fetch ? { fetch: platform.fetch } : {}),
  });
  const unbound = () => Promise.reject(new Error('Not available in this build yet'));
  const api = sdkApi(client, session, { esim: { usage: unbound }, concierge: { start: unbound }, invites: { accept: unbound } } as unknown as Parameters<typeof sdkApi>[2]);
  const opener: Opener = { openURL: (url) => Linking.openURL(url).then(() => undefined), openSettings: () => Linking.openSettings() };
  return {
    api,
    session,
    authenticator,
    opener,
    locale: platform.language?.startsWith('he') ? 'he' : 'en',
    ...(loadPersonas ? { personas: { load: loadPersonas, current: () => persona, choose: (key: string) => void (persona = key) } } : {}),
  };
}

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

export default function RootLayout() {
  const expo = useExpoRouter();
  const segments = useSegments();
  const search = useGlobalSearchParams();
  const ready = useRootNavigationState()?.key !== undefined;
  const params = useMemo(() => Object.fromEntries(Object.entries(search).map(([k, v]) => [k, first(v)])), [search]);
  const router = useMemo<Router>(() => ({ push: (h) => expo.push(h as ExpoHref), replace: (h) => expo.replace(h as ExpoHref), back: () => expo.back() }), [expo]);
  const deps = useRef<RootDeps | undefined>(undefined);
  deps.current ??= createRootDeps(parseMobileConfig(buildEnv()), {
    credentials: globalThis.navigator?.credentials,
    storage: typeof localStorage === 'undefined' ? undefined : localStorage,
    persona: params['persona'],
    language: globalThis.navigator?.language,
  });
  return (
    <RootLayoutView deps={deps.current} router={router} segments={segments} params={params} ready={ready}>
      <Slot />
    </RootLayoutView>
  );
}
