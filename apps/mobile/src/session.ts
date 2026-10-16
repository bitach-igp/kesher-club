// Signed-in session holder. Tokens are kept in memory here and in the secure store by the real
// app; nothing in this module logs or serialises them.
import { createContext, useContext } from 'react';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: string;
  /** Set during the 24 h recovery hold (REQ-AUTH-003). */
  restrictedUntil?: string;
}

export interface Session {
  signIn(tokens: TokenPair): void;
  signOut(): void;
  /** Short-lived token from verifyOtp, used only to enrol a passkey. */
  setOtpSession(token: string | undefined): void;
  accessToken(): string | undefined;
  otpSession(): string | undefined;
  restrictedUntil(): string | undefined;
}

export function memorySession(): Session {
  let tokens: TokenPair | undefined;
  let otp: string | undefined;
  return {
    signIn: (t) => {
      tokens = t;
      otp = undefined;
    },
    signOut: () => {
      tokens = undefined;
      otp = undefined;
    },
    setOtpSession: (t) => void (otp = t),
    accessToken: () => tokens?.accessToken,
    otpSession: () => otp,
    restrictedUntil: () => tokens?.restrictedUntil,
  };
}

export const SessionContext = createContext<Session | undefined>(undefined);
export const SessionProvider = SessionContext.Provider;
export function useSession(): Session {
  const s = useContext(SessionContext);
  if (!s) throw new Error('SessionProvider is missing');
  return s;
}
