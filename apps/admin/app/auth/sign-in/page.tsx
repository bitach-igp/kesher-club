// Sign-in page: one button to Identity Center. The reason query explains why the admin is here.
import { SIGN_IN_REASON_TEXT, type SignInReason } from '../../../src/auth/guard.ts';

const isReason = (r: string | undefined): r is SignInReason => r !== undefined && r in SIGN_IN_REASON_TEXT;

export default async function SignInPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const reasonParam = typeof sp['reason'] === 'string' ? sp['reason'] : undefined;
  const reason: SignInReason = isReason(reasonParam) ? reasonParam : 'no_session';
  const returnTo = typeof sp['return_to'] === 'string' && sp['return_to'].startsWith('/') ? sp['return_to'] : '/';
  const start = `/auth/start?${new URLSearchParams({ return_to: returnTo }).toString()}`;
  return (
    <main style={{ maxWidth: 480, margin: '10vh auto', padding: 24 }}>
      <h1>Kesher Club admin</h1>
      <p role={reason === 'no_session' ? undefined : 'alert'}>{SIGN_IN_REASON_TEXT[reason]}</p>
      <a href={start} className="button">
        Sign in with Identity Center
      </a>
      <p className="muted">VPN and a security key or passkey are required.</p>
    </main>
  );
}
