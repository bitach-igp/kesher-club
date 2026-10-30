'use client';
// Deposits' interactive half (T-0630): the pull form. The decisions (the amount, the step-up retry, keeping the
// attempt's key until the pull lands) live in src/deposits.ts; this renders them.
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { errorKey, submitPull, type Attempt, type Outcome, type PullDeps } from '../../src/deposits.ts';
import { t, type Locale } from '../../src/i18n.ts';
import { passkeyStepUp } from '../step-up-flow.ts';
import * as actions from './actions.ts';

const deps: PullDeps = { create: actions.createAchPull, stepUp: passkeyStepUp, newKey: () => crypto.randomUUID() };

function Problem({ outcome, locale }: { outcome: Outcome | undefined; locale: Locale }) {
  if (!outcome || outcome.kind === 'done') return null;
  if (outcome.kind === 'invalid') return <p role="alert" className="error" data-testid="pull-problem">{t('deposits.form.problem', locale)}</p>;
  if (outcome.kind === 'cancelled') return <p role="alert" className="error" data-testid="pull-cancelled">{t('deposits.cancelled', locale)}</p>;
  return <p role="alert" className="error" data-testid="pull-error">{t(errorKey(outcome.code), locale)}</p>;
}

export function NewPull({ locale }: { locale: Locale }) {
  const router = useRouter();
  const [amountText, setAmountText] = useState('');
  const [attempt, setAttempt] = useState<Attempt | undefined>();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | undefined>();
  const submit = async () => {
    setBusy(true);
    const r = await submitPull(deps, amountText, attempt);
    setBusy(false);
    setAttempt(r.attempt);
    setOutcome(r.outcome);
    if (r.outcome.kind === 'done') {
      setAmountText('');
      router.refresh();
    }
  };
  return (
    <div className="card">
      <label style={{ display: 'block', marginBottom: 8 }}>
        {t('deposits.form.amount', locale)}
        <br />
        <input value={amountText} onChange={(e) => setAmountText(e.target.value)} inputMode="decimal" dir="ltr" data-testid="pull-amount" style={{ width: '100%', padding: 6 }} />
      </label>
      <button className="primary" type="button" disabled={busy} onClick={() => void submit()} data-testid="pull-submit">{t('deposits.form.submit', locale)}</button>
      <Problem outcome={outcome} locale={locale} />
    </div>
  );
}
