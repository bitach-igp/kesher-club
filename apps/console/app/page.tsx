// The console's landing (T-0608): the proxy has resolved the session; this page shows the staff member's
// own institution, or "no institution access" and nothing else. The I01 dashboard content comes later.
import { headers } from 'next/headers';
import { decodeLanding, LANDING_HEADER } from '../src/session.ts';
import { signOut } from './sign-in/actions.ts';

const ROLE_LABEL = { staff: 'Staff', finance: 'Finance', admin: 'Institution admin' } as const;

export default async function Home() {
  const landing = decodeLanding((await headers()).get(LANDING_HEADER));
  const leave = (
    <form action={signOut}>
      <button type="submit" data-testid="sign-out">Sign out</button>
    </form>
  );
  if (landing.kind !== 'dashboard') {
    return (
      <>
        <h1>No institution access</h1>
        <div className="card" data-testid="no-access">
          <p>This account is not staff of an institution on Kesher Club. An institution admin, or Kesher support, can add you.</p>
          {leave}
        </div>
      </>
    );
  }
  return (
    <>
      <h1 data-testid="institution-name">{landing.institution.name}</h1>
      <div className="card" data-testid="dashboard">
        <dl>
          <dt>Your role</dt>
          <dd data-testid="institution-role">{ROLE_LABEL[landing.role]}</dd>
          <dt>Market</dt>
          <dd>{landing.institution.market}</dd>
        </dl>
        <p>
          <a href="/allowances" data-testid="nav-allowances">Allowances</a> · <a href="/collections" data-testid="nav-collections">Collections</a>
        </p>
        <p className="muted">Payouts arrive here next.</p>
        {leave}
      </div>
    </>
  );
}
