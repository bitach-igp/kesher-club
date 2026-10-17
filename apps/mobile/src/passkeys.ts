// Passkey seam. The real app binds expo-passkeys / react-native-passkey; tests use `fakeAuthenticator`.
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
