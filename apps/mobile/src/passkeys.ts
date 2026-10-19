// Passkey seam. The root layout binds the browser's WebAuthn, or in a development build a demo persona's
// seeded passkey (T-0033); the native app will bind expo-passkeys; tests use `fakeAuthenticator`.
// Options and responses are opaque WebAuthn JSON from the API; the app never inspects them.
import { createContext, useContext } from 'react';

export interface Authenticator {
  /** Registration ceremony (navigator.credentials.create). */
  create(options: unknown): Promise<unknown>;
  /** Assertion ceremony (navigator.credentials.get). */
  get(options: unknown): Promise<unknown>;
}

export class PasskeyCancelled extends Error {
  readonly code = 'PASSKEY_CANCELLED';
  constructor() {
    super('Passkey ceremony cancelled');
    this.name = 'PasskeyCancelled';
  }
}

export class NoPasskey extends Error {
  readonly code = 'NO_PASSKEY';
  constructor() {
    super('No passkey on this device');
    this.name = 'NoPasskey';
  }
}

/**
 * The platform authenticator through the browser's WebAuthn (T-0033): options arrive as WebAuthn JSON
 * and responses leave as `PublicKeyCredential.toJSON()`. A dismissed prompt is a cancel; a browser
 * without WebAuthn has no passkey. The native app binds expo-passkeys here instead.
 */
export function webAuthnAuthenticator(credentials: CredentialsContainer | undefined = globalThis.navigator?.credentials): Authenticator {
  const ceremony = async (run: (c: CredentialsContainer) => Promise<Credential | null>): Promise<unknown> => {
    if (!credentials || typeof PublicKeyCredential === 'undefined') throw new NoPasskey();
    let credential: Credential | null;
    try {
      credential = await run(credentials);
    } catch (e) {
      if (e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'AbortError')) throw new PasskeyCancelled();
      throw e;
    }
    if (!credential) throw new PasskeyCancelled();
    return (credential as PublicKeyCredential).toJSON();
  };
  return {
    create: (options) => ceremony((c) => c.create({ publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(options as PublicKeyCredentialCreationOptionsJSON) })),
    get: (options) => ceremony((c) => c.get({ publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(options as PublicKeyCredentialRequestOptionsJSON) })),
  };
}

/** What a development build signs with: the chosen demo persona's seeded passkey, or none yet. */
export interface SeededDevice {
  register(options: never): Promise<unknown>;
  authenticate(options: never): Promise<unknown>;
}

/**
 * The development build's authenticator: signs as the persona picked on the sign-in screen, so a
 * person seeded by T-0032 signs in without a hardware key. With no persona picked there is no passkey.
 */
export function seededAuthenticator(device: () => Promise<SeededDevice | undefined>): Authenticator {
  const current = async (): Promise<SeededDevice> => {
    const d = await device();
    if (!d) throw new NoPasskey();
    return d;
  };
  return {
    create: async (options) => (await current()).register(options as never),
    get: async (options) => (await current()).authenticate(options as never),
  };
}

export const AuthenticatorContext = createContext<Authenticator | undefined>(undefined);
export const AuthenticatorProvider = AuthenticatorContext.Provider;
export function useAuthenticator(): Authenticator {
  const a = useContext(AuthenticatorContext);
  if (!a) throw new Error('AuthenticatorProvider is missing');
  return a;
}

export function fakeAuthenticator(behaviour: { create?: 'ok' | 'cancel'; get?: 'ok' | 'cancel' | 'none' } = {}): Authenticator & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async create(options) {
      calls.push('create');
      if (behaviour.create === 'cancel') throw new PasskeyCancelled();
      return { type: 'public-key', registration: options };
    },
    async get(options) {
      calls.push('get');
      if (behaviour.get === 'cancel') throw new PasskeyCancelled();
      if (behaviour.get === 'none') throw new NoPasskey();
      return { type: 'public-key', assertion: options };
    },
  };
}
