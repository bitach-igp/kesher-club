// The console's landing (T-0608): the proxy has resolved the session; this page shows the staff member's own
// institution's dashboard (I02, T-0635), or "no institution access" with the way to apply (I01, T-0633).
import { headers } from 'next/headers';
import { codeOf, institutionApi, memberApi } from '../src/api.ts';
import { balances, feeLines, funnel, isEmpty, runLines, TILES, type Dashboard } from '../src/dashboard.ts';
import { getConfig } from '../src/config.ts';
import { fmt } from '../src/allowances.ts';
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
  const { access, locale } = await requestContext();
  let d: Dashboard | undefined;
  try {
    d = access ? await institutionApi(getConfig().CONSOLE_API_URL, access).dashboard(landing.institution.id) : undefined;
  } catch (e) {
    if (!codeOf(e)) throw e;
  }
  const f = d ? funnel(d) : undefined;
  return (
    <>
      <h1 data-testid="institution-name">{landing.institution.name}</h1>
      {!d || !f ? (
        <div className="card" role="status" data-testid="dash-unavailable">{t('dash.unavailable', locale)}</div>
      ) : (
        <>
          <div className="card" data-testid="dash-funnel">
            <h2>{t('dash.funnel', locale)}</h2>
            {isEmpty(d) ? (
              <p data-testid="dash-empty">{t('dash.empty', locale)}</p>
            ) : (
              <dl>
                {(['invited', 'verified', 'active'] as const).map((k) => (
                  <div key={k} style={{ display: 'contents' }}>
                    <dt>{t(`dash.funnel.${k}`, locale)}</dt>
                    <dd data-testid={`dash-funnel-${k}`}>{t('dash.funnel.line', locale, { count: f[k], percent: f.percent[k] })}</dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
          <div className="card" data-testid="dash-balance">
            <h2>{t('dash.balance', locale)}</h2>
            {balances(d, landing.institution.market).map((m) => (
              <p key={m.currency}>
                <strong>{fmt({ minor: m.minor.toString(), currency: m.currency }, locale)}</strong>
              </p>
            ))}
          </div>
          <div className="card" data-testid="dash-runs">
            <h2>{t('dash.runs', locale)}</h2>
            {d.upcomingRuns.length === 0 ? <p className="muted">{t('dash.runs.none', locale)}</p> : null}
            {/* Schedule names are staff text, shown as written. */}
            {runLines(d, locale).map((r) => (
              <p key={`${r.date}-${r.name}`}>{t('dash.runs.line', locale, { date: r.date, name: r.name, amount: r.amount, members: r.members })}</p>
            ))}
          </div>
          <div className="card" data-testid="dash-fees">
            <h2>{t('dash.fees', locale)}</h2>
            {d.feesDue.length === 0 ? <p className="muted">{t('dash.fees.none', locale)}</p> : feeLines(d, locale).map((l) => <p key={l}>{l}</p>)}
          </div>
        </>
      )}
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
        <p className="row">
          {TILES.map((x) => (
            <a key={x.href} href={x.href} data-testid={`nav-${x.href.slice(1)}`}>
              {t(x.label, locale)}
            </a>
          ))}
        </p>
        {leave}
      </div>
    </>
  );
}
