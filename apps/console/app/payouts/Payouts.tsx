'use client';
// I09's interactive half (T-0612): the withdrawal form and the second member's approve / reject. The
// decisions (amount check, step-up retry, a reject's reason) live in src/payouts.ts; this renders them.
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { t, type CopyKey, type Locale } from '../../src/i18n.ts';
import { approvePayout, rejectPayout, submitPayout, type Draft, type Outcome, type PayoutDeps } from '../../src/payouts.ts';
import { passkeyStepUp } from '../step-up-flow.ts';
import * as actions from './actions.ts';

const deps: PayoutDeps = { create: actions.createPayout, approve: actions.approvePayout, reject: actions.rejectPayout, stepUp: passkeyStepUp, newKey: () => crypto.randomUUID() };

const errorKey = (code: string): CopyKey => (code === 'INSUFFICIENT_FUNDS' ? 'payouts.insufficient' : code === 'FORBIDDEN' || code === 'NOT_FOUND' ? 'error.forbidden' : 'error.generic');

function Problem({ outcome, locale }: { outcome: Outcome | undefined; locale: Locale }) {
  if (!outcome || outcome.kind === 'done') return null;
  if (outcome.kind === 'cancelled') return <p role="alert" className="error" data-testid="payout-cancelled">{t('payouts.cancelled', locale)}</p>;
  if (outcome.kind === 'invalid') return <>{outcome.problems.map((p) => <p key={p} role="alert" className="error" data-testid={`payout-problem-${p}`}>{t(`payouts.form.problem.${p}`, locale)}</p>)}</>;
  return <p role="alert" className="error" data-testid="payout-error">{t(errorKey(outcome.code), locale)}</p>;
}

export function NewPayout({ available, locale }: { available: string; locale: Locale }) {
  const router = useRouter();
  const [draft, setDraft] = useState<Draft>({ amountText: '', reference: '' });
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | undefined>();
  const field = (k: keyof Draft, label: CopyKey, extra: Record<string, string> = {}) => (
    <label style={{ display: 'block', marginBottom: 8 }}>
      {t(label, locale)}
      <br />
      <input value={draft[k]} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} data-testid={`payout-${k}`} style={{ width: '100%', padding: 6 }} {...extra} />
    </label>
  );
  const submit = async () => {
    setBusy(true);
    const o = await submitPayout(deps, draft, BigInt(available));
    setBusy(false);
    setOutcome(o);
    if (o.kind === 'done') router.push('/payouts');
  };
  return (
    <div className="card">
      {field('amountText', 'payouts.form.amount', { inputMode: 'decimal', dir: 'ltr' })}
      {field('reference', 'payouts.form.reference')}
      <button className="primary" type="button" disabled={busy} onClick={() => void submit()} data-testid="payout-submit">{t('payouts.form.submit', locale)}</button>
      <Problem outcome={outcome} locale={locale} />
    </div>
  );
}

export function Decide({ payoutId, locale }: { payoutId: string; locale: Locale }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  const [outcome, setOutcome] = useState<Outcome | undefined>();
  const run = async (f: () => Promise<Outcome>) => {
    setBusy(true);
    const o = await f();
    setBusy(false);
    setOutcome(o);
    if (o.kind === 'done') router.refresh();
  };
  return (
    <div className="row" style={{ alignItems: 'center' }}>
      <button className="primary" type="button" disabled={busy} onClick={() => void run(() => approvePayout(deps, payoutId))} data-testid={`approve-${payoutId}`}>{t('payouts.approve', locale)}</button>
      <input placeholder={t('payouts.reject.reason', locale)} value={reason} onChange={(e) => setReason(e.target.value)} data-testid={`reason-${payoutId}`} style={{ padding: 6 }} />
      <button type="button" disabled={busy} onClick={() => void run(() => rejectPayout(deps, payoutId, reason))} data-testid={`reject-${payoutId}`}>{t('payouts.reject', locale)}</button>
      {/* The only invalid decision is a reject without its reason. */}
      {outcome?.kind === 'invalid' ? <p role="alert" className="error" data-testid={`reason-needed-${payoutId}`}>{t('payouts.reject.reason', locale)}</p> : <Problem outcome={outcome} locale={locale} />}
    </div>
  );
}
