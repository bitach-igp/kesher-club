'use client';
// The browser half of sign-in (T-0608): options in, the platform authenticator's assertion out, and the
// server actions do the rest. A local development build adds the seeded demo staff; a production build
// drops that branch (NODE_ENV is replaced at build), so the personas never ship.
import { useEffect, useState } from 'react';
import { loadPersonas, personaAssert, rememberPersona, webAuthnAssert } from '../../src/passkey.ts';
import { beginSignIn, finishSignIn } from './actions.ts';

type Persona = { key: string; name: string };
type Assert = (options: unknown) => Promise<unknown>;

const MESSAGES = { rejected: 'That passkey was not accepted.', unavailable: 'Kesher Club is not reachable right now. Try again shortly.', cancelled: 'Sign-in was cancelled.' } as const;

export function SignIn({ demo }: { demo: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<keyof typeof MESSAGES | undefined>();
  const [personas, setPersonas] = useState<Persona[]>([]);

  useEffect(() => {
    if (demo && loadPersonas) {
      void loadPersonas().then((m) => setPersonas(m.PERSONAS.filter((p) => p.staff).map(({ key, name }) => ({ key, name }))));
    }
  }, [demo]);

  const run = async (assert: Assert) => {
    setBusy(true);
    setError(undefined);
    try {
      const begun = await beginSignIn();
      if (!begun.ok) return setError(begun.error);
      let response: unknown;
      try {
        response = await assert(begun.options);
      } catch {
        return setError('cancelled');
      }
      const done = await finishSignIn(response);
      if (!done.ok) return setError(done.error);
      window.location.assign('/');
    } finally {
      setBusy(false);
    }
  };

  const asPersona = (key: string): Assert => async (options) => {
    const response = await personaAssert(key, options);
    rememberPersona(key);
    return response;
  };

  return (
    <>
      <div className="row">
        <button className="primary" type="button" disabled={busy} onClick={() => {
            rememberPersona(undefined);
            void run(webAuthnAssert);
          }} data-testid="sign-in-passkey">
          Sign in with a passkey
        </button>
      </div>
      {error ? (
        <p className="error" role="alert" data-testid="sign-in-error">
          {MESSAGES[error]}
        </p>
      ) : null}
      {personas.length ? (
        <>
          <p className="muted">Local demo: sign in as seeded staff.</p>
          <div className="row">
            {personas.map((p) => (
              <button key={p.key} type="button" disabled={busy} onClick={() => void run(asPersona(p.key))} data-testid={`persona-${p.key}`}>
                {p.name}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </>
  );
}
