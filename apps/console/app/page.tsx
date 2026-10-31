// The console's landing (T-0608): the proxy has resolved the session; this page shows the staff member's
// own institution, or "no institution access" and nothing else. The I01 dashboard content comes later.
import { headers } from 'next/headers';
import { codeOf, memberApi } from '../src/api.ts';
import { getConfig } from '../src/config.ts';
import { t } from '../src/i18n.ts';
import { requestContext } from '../src/request.ts';
import { decodeLanding, LANDING_HEADER } from '../src/session.ts';
import { signOut } from './sign-in/actions.ts';

/** I01 (T-0633): someone with no institution continues their application, or starts one while applications are open. */
async function applyLink(access: string | undefined): Promise<'apply.start' | 'apply.continue' | undefined> {
  if (!access) return undefined;
  const api = memberApi(getConfig().CONSOLE_API_URL, access);
  try {
    await api.myApplication();
    return 'apply.continue';
  } catch (e) {
    if (codeOf(e) !== 'NOT_FOUND') throw e;
  }
  return (await api.capabilities()).features['institutions.selfServe'] === true ? 'apply.start' : undefined;
}

const ROLE_LABEL = { staff: 'Staff', finance: 'Finance', admin: 'Institution admin' } as const;

export default async function Home() {
  const landing = decodeLanding((await headers()).get(LANDING_HEADER));
  const leave = (
    <form action={signOut}>
      <button type="submit" data-testid="sign-out">Sign out</button>
    </form>
  );
  if (landing.kind !== 'dashboard') {
    const { access, locale } = await requestContext();
    const apply = await applyLink(access);
    return (
      <>
        <h1>No institution access</h1>
        <div className="card" data-testid="no-access">
          <p>This account is not staff of an institution on Kesher Club. An institution admin, or Kesher support, can add you.</p>
          {apply ? (
            <p>
              <a href="/apply" data-testid="apply-link">{t(apply, locale)}</a>
            </p>
          ) : null}
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
          <dt>Payment reference</dt>
          <dd>
            <code data-testid="payment-reference">{landing.paymentReference}</code>
            <span className="muted"> · quote it on every transfer into Kesher Club, so the money reaches your account</span>
          </dd>
        </dl>
        <p>
          <a href="/allowances" data-testid="nav-allowances">Allowances</a> · <a href="/collections" data-testid="nav-collections">Collections</a> · <a href="/payouts" data-testid="nav-payouts">Payouts</a>
        </p>
        {leave}
      </div>
    </>
  );
}
