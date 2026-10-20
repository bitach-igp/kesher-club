// The browser's passkey assertion (T-0608, T-0610), for sign-in and step-up. A local development build
// that signed in as a seeded demo persona keeps signing as that persona; a production build drops that
// branch (NODE_ENV is replaced at build), so the personas never ship.
const PERSONA_KEY = 'kesher_console_persona';

/** The seeded personas, in a development build only. */
export const loadPersonas = process.env.NODE_ENV !== 'production' ? () => import('@kesher/demo/personas') : undefined;

export async function webAuthnAssert(options: unknown): Promise<unknown> {
  if (typeof PublicKeyCredential === 'undefined' || !navigator.credentials) throw new Error('This browser has no passkeys');
  const credential = await navigator.credentials.get({ publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(options as PublicKeyCredentialRequestOptionsJSON) });
  if (!credential) throw new Error('cancelled');
  return (credential as PublicKeyCredential).toJSON();
}

export async function personaAssert(key: string, options: unknown): Promise<unknown> {
  const m = await loadPersonas?.();
  const p = m?.PERSONAS.find((x) => x.key === key);
  if (!m || !p) throw new Error('unknown persona');
  return (await m.passkeyOf(p)).authenticate(options as never);
}

/** Remembers (or forgets) the demo persona this tab signed in as, so its step-ups sign as the same person. */
export function rememberPersona(key: string | undefined): void {
  try {
    if (key) sessionStorage.setItem(PERSONA_KEY, key);
    else sessionStorage.removeItem(PERSONA_KEY);
  } catch {
    // Storage blocked: step-up falls back to the platform passkey.
  }
}

/** Step-up's assertion: the remembered demo persona in a development build, the platform passkey otherwise. */
export async function stepUpAssert(options: unknown): Promise<unknown> {
  const persona = loadPersonas ? rememberedPersona() : null;
  return persona ? personaAssert(persona, options) : webAuthnAssert(options);
}

function rememberedPersona(): string | null {
  try {
    return sessionStorage.getItem(PERSONA_KEY);
  } catch {
    return null;
  }
}
