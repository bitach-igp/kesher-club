'use client';
// The US bank account screen's interactive half (T-0651): the application form and funding. The decisions (the amount, the quote, the
// step-up retry, who may approve, keeping a request's key until it lands) live in src/us-banking.ts; this renders them.
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { fmt } from '../../src/allowances.ts';
import { intlLocale, t, type Locale } from '../../src/i18n.ts';
import { askQuote, canApprove, canCancel, attemptFor, errorKey, fundingLine, resumeBody, startBody, submitApprove, submitCancel, submitRequest, submitStart, type Attempt, type Problem, type UsBankingDeps, type UsFunding, type UsFundingQuote } from '../../src/us-banking.ts';
import { passkeyStepUp } from '../step-up-flow.ts';
import * as actions from './actions.ts';

const deps: UsBankingDeps = {
  start: actions.startUsBanking,
  quote: actions.quoteUsFunding,
  request: actions.requestUsFunding,
  approve: actions.approveUsFunding,
  cancel: actions.cancelUsFunding,
  stepUp: passkeyStepUp,
  newKey: () => crypto.randomUUID(),
};

function Trouble({ problem, locale, invalid, testid, during = 'page' }: { problem: Problem | undefined; locale: Locale; invalid: 'usbank.start.problem' | 'usbank.fund.problem'; testid: string; during?: 'page' | 'fund' }) {
  if (!problem) return null;
  const key = problem.kind === 'invalid' ? invalid : problem.kind === 'cancelled' ? 'usbank.fund.cancelled' : errorKey(problem.code, during);
  return <p role="alert" className="error" data-testid={testid}>{t(key, locale)}</p>;
}

export function Start({ locale, resume }: { locale: Locale; resume: boolean }) {
  const router = useRouter();
  const [holder, setHolder] = useState<'platform' | 'institution'>('platform');
  const [legalName, setLegalName] = useState('');
  const [ein, setEin] = useState('');
  const [attempt, setAttempt] = useState<Attempt | undefined>();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | undefined>();
  const [formUrl, setFormUrl] = useState<string | undefined>();
  const submit = async () => {
    setBusy(true);
    // Resuming is on the entity the institution already has: the holder is fixed and nothing is typed again.
    const body = resume ? resumeBody() : startBody(holder, legalName, ein);
    const key = attemptFor(attempt, JSON.stringify(body ?? null), deps.newKey);
    setAttempt(key);
    try {
      const r = await submitStart(deps, body, key);
      setAttempt(r.attempt);
      if (r.outcome.kind === 'done') {
        setProblem(undefined);
        setFormUrl(r.outcome.value.formUrl);
        router.refresh();
      } else setProblem(r.outcome);
    } catch {
      // The answer was lost (the network, a timeout): the attempt's key is kept, so trying again reaches the same application.
      setProblem({ kind: 'error', code: 'UNKNOWN' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card">
      <h2>{t('usbank.start.title', locale)}</h2>
      {resume ? null : (
        <>
          <label style={{ display: 'block', marginBottom: 8 }}>
            <input type="radio" name="holder" checked={holder === 'platform'} onChange={() => setHolder('platform')} data-testid="start-holder-platform" /> {t('usbank.start.holder.platform', locale)}
          </label>
          <label style={{ display: 'block', marginBottom: 8 }}>
            <input type="radio" name="holder" checked={holder === 'institution'} onChange={() => setHolder('institution')} data-testid="start-holder-institution" /> {t('usbank.start.holder.institution', locale)}
          </label>
          {holder === 'institution' ? (
            <>
              <label style={{ display: 'block', marginBottom: 8 }}>
                {t('usbank.start.legalName', locale)}
                <br />
                <input value={legalName} onChange={(e) => setLegalName(e.target.value)} maxLength={200} data-testid="start-legal-name" style={{ width: '100%', padding: 6 }} />
              </label>
              <label style={{ display: 'block', marginBottom: 8 }}>
                {t('usbank.start.ein', locale)}
                <br />
                <input value={ein} onChange={(e) => setEin(e.target.value)} dir="ltr" data-testid="start-ein" style={{ width: '100%', padding: 6 }} />
              </label>
            </>
          ) : null}
        </>
      )}
      <button className="primary" type="button" disabled={busy} onClick={() => void submit()} data-testid="start-submit">{t(resume ? 'usbank.start.continue' : 'usbank.start.submit', locale)}</button>
      <Trouble problem={problem} locale={locale} invalid="usbank.start.problem" testid="start-problem" />
      {formUrl && /^https:\/\//.test(formUrl) ? (
        <p data-testid="start-opened">
          {t('usbank.start.opened', locale)} <a href={formUrl} target="_blank" rel="noopener noreferrer">{t('usbank.start.open', locale)}</a>
        </p>
      ) : null}
    </div>
  );
}

export function Funding({ locale, role, me, items }: { locale: Locale; role: 'staff' | 'finance' | 'admin'; me: string | undefined; items: readonly UsFunding[] }) {
  const router = useRouter();
  const [amountText, setAmountText] = useState('');
  const [quote, setQuote] = useState<UsFundingQuote | undefined>();
  const [attempt, setAttempt] = useState<Attempt | undefined>();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | undefined>();
  const [asked, setAsked] = useState(false);
  const lost = (): Problem => ({ kind: 'error', code: 'UNKNOWN' });
  const getQuote = async () => {
    setBusy(true);
    setAsked(false);
    try {
      const r = await askQuote(deps, amountText);
      if (r.outcome.kind === 'done') {
        setProblem(undefined);
        setQuote(r.outcome.value);
      } else {
        setQuote(undefined);
        setProblem(r.outcome);
      }
    } catch {
      setProblem(lost());
    } finally {
      setBusy(false);
    }
  };
  const request = async () => {
    if (!quote) return;
    setBusy(true);
    // The key is kept before the call: if the answer is lost, trying again with this quote is the same request.
    const kept = attemptFor(attempt, quote.quoteId, deps.newKey);
    setAttempt(kept);
    try {
      const r = await submitRequest(deps, quote, kept);
      setAttempt(r.attempt);
      if (r.outcome.kind === 'done') {
        setProblem(undefined);
        setQuote(undefined);
        setAmountText('');
        setAsked(true);
        router.refresh();
      } else setProblem(r.outcome);
    } catch {
      setProblem(lost());
    } finally {
      setBusy(false);
    }
  };
  const act = async (go: () => ReturnType<typeof submitApprove>) => {
    setBusy(true);
    try {
      const r = await go();
      if (r.outcome.kind === 'done') {
        setProblem(undefined);
        router.refresh();
      } else setProblem(r.outcome);
    } catch {
      setProblem(lost());
    } finally {
      setBusy(false);
    }
  };
  const when = (iso: string) => new Date(iso).toLocaleString(intlLocale(locale), { timeZone: 'Asia/Jerusalem', dateStyle: 'medium', timeStyle: 'short' });
  const day = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString(intlLocale(locale), { timeZone: 'UTC', dateStyle: 'medium' });
  return (
    <>
      <div className="card">
        <h2>{t('usbank.fund.title', locale)}</h2>
        <p className="muted">{t('usbank.fund.intro', locale)}</p>
        <label style={{ display: 'block', marginBottom: 8 }}>
          {t('usbank.fund.amount', locale)}
          <br />
          <input value={amountText} onChange={(e) => setAmountText(e.target.value)} inputMode="decimal" dir="ltr" data-testid="fund-amount" style={{ width: '100%', padding: 6 }} />
        </label>
        <button type="button" disabled={busy} onClick={() => void getQuote()} data-testid="fund-quote">{t('usbank.fund.quote', locale)}</button>
        {quote ? (
          <p data-testid="fund-quote-line">
            {t(quote.arrivesOn ? 'usbank.fund.quote.line' : 'usbank.fund.quote.nodate', locale, { fee: fmt(quote.fee, locale), date: quote.arrivesOn ? day(quote.arrivesOn) : '', until: when(quote.expiresAt) })}
          </p>
        ) : null}
        {quote ? <button className="primary" type="button" disabled={busy} onClick={() => void request()} data-testid="fund-request">{t('usbank.fund.request', locale)}</button> : null}
        {asked ? <p data-testid="fund-requested">{t('usbank.fund.requested', locale)}</p> : null}
        <Trouble problem={problem} locale={locale} invalid="usbank.fund.problem" testid="fund-problem" during="fund" />
      </div>
      <h2>{t('usbank.fund.list', locale)}</h2>
      {items.length === 0 ? <p className="muted">{t('usbank.fund.none', locale)}</p> : null}
      {items.map((r) => (
        <div className="card" key={r.id} data-testid={`funding-${r.id}`}>
          <strong>{fmt(r.amount, locale)}</strong> <span className="muted">{t('usbank.fund.fee', locale, { fee: fmt(r.fee, locale) })}</span>
          <div data-testid="funding-status" className={r.status === 'returned' || r.status === 'rejected' || r.status === 'failed' || r.status === 'needs_review' ? 'error' : undefined}>{t(fundingLine(r), locale)}</div>
          {r.status === 'awaiting_approval' && !canApprove(r, me, role) ? <div className="muted" data-testid="funding-own">{t(r.requestedBy === me ? 'usbank.fund.own' : 'usbank.fund.waiting', locale)}</div> : null}
          <div className="row">
            {canApprove(r, me, role) ? <button className="primary" type="button" disabled={busy} onClick={() => void act(() => submitApprove(deps, r.id))} data-testid="funding-approve">{t('usbank.fund.approve', locale)}</button> : null}
            {canCancel(r) ? <button type="button" disabled={busy} onClick={() => void act(() => submitCancel(deps, r.id))} data-testid="funding-cancel">{t('usbank.fund.cancel', locale)}</button> : null}
          </div>
        </div>
      ))}
    </>
  );
}
