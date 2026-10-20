// I09 Payouts (T-0612, REQ-PO-001/002, REQ-INS-004): the institution's payouts out of its own account, newest
// first, with where each stands (cooling off until when, waiting for whom, returned by the bank), and
// Approve / Reject for a second finance member.
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { codeOf, institutionApi } from '../../src/api.ts';
import { fmt } from '../../src/allowances.ts';
import { getConfig } from '../../src/config.ts';
import { t, type Locale } from '../../src/i18n.ts';
import { canDecide, type InstitutionPayout } from '../../src/payouts.ts';
import { requestContext } from '../../src/request.ts';
import { Decide } from './Payouts.tsx';

const when = (iso: string, locale: Locale): string => new Date(iso).toLocaleString(locale === 'he' ? 'he-IL' : 'en-GB', { timeZone: 'Asia/Jerusalem', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function stateText(p: InstitutionPayout, locale: Locale): string {
  if (p.state === 'cooling_off') return t('payouts.state.cooling_off', locale, { time: p.coolOffEndsAt ? when(p.coolOffEndsAt, locale) : '' });
  if (p.state === 'reversed') return t('payouts.state.reversed', locale, { code: p.failureCode ?? '' });
  return t(`payouts.state.${p.state}`, locale);
}

export default async function PayoutsPage({ searchParams }: { searchParams: Promise<{ cursor?: string }> }) {
  const { landing, access, locale } = await requestContext();
  if (landing.kind !== 'dashboard' || !access) redirect('/');
  let page;
  try {
    page = await institutionApi(getConfig().CONSOLE_API_URL, access).payouts(landing.institution.id, (await searchParams).cursor);
  } catch (e) {
    if (codeOf(e) !== 'NOT_FOUND' && codeOf(e) !== 'FORBIDDEN') throw e;
    return <div className="card" data-testid="payouts-forbidden">{t('error.forbidden', locale)}</div>;
  }
  return (
    <>
      <h1>{t('payouts.title', locale)}</h1>
      <p className="row">
        <strong data-testid="payouts-available">{t('payouts.available', locale, { amount: fmt(page.available, locale) })}</strong>
        <Link href="/payouts/new" data-testid="payouts-new">{t('payouts.new', locale)}</Link>
      </p>
      {page.items.length === 0 ? <p className="muted">{t('payouts.none', locale)}</p> : null}
      {page.items.map((p) => (
        <div className="card" key={p.id} data-testid={`payout-${p.id}`}>
          <strong>{t('payouts.to', locale, { amount: fmt(p.amount, locale), payee: p.payee.name, last4: p.payee.ibanLast4 })}</strong>
          <div className="muted">{t('payouts.reference', locale, { reference: p.reference })}</div>
          <div data-testid="payout-state" className={p.state === 'reversed' || p.state === 'rejected' || p.state === 'failed' ? 'error' : undefined}>{stateText(p, locale)}</div>
          {p.requestedBy ? <div className="muted">{t('allowances.requestedBy', locale, { name: p.requestedBy.displayName })}</div> : null}
          {p.approvedBy.length ? <div className="muted">{t('allowances.approvedBy', locale, { names: p.approvedBy.map((a) => a.displayName).join(', ') })}</div> : null}
          {p.state === 'awaiting_second_approval' && p.requestedByMe ? <div className="muted" data-testid="payout-mine">{t('payouts.mine', locale)}</div> : null}
          {canDecide(p, landing.role) ? <Decide payoutId={p.id} locale={locale} /> : null}
        </div>
      ))}
      {page.nextCursor ? <Link href={`/payouts?cursor=${encodeURIComponent(page.nextCursor)}`}>{t('payouts.more', locale)}</Link> : null}
    </>
  );
}
