'use client';
// I08's bill-members form (T-0629). The decisions (the amount and due-date checks, the outcome) live in
// src/collections.ts; this renders them. A bill goes back to the month, where every member now owes it.
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { billMembers, type BillDeps, type BillDraft, type BillOutcome } from '../../src/collections.ts';
import { t, type CopyKey, type Locale } from '../../src/i18n.ts';
import * as actions from './actions.ts';

const deps: BillDeps = { create: actions.billMembers, newKey: () => crypto.randomUUID() };

function Problem({ outcome, locale }: { outcome: BillOutcome | undefined; locale: Locale }) {
  if (!outcome || outcome.kind === 'done') return null;
  if (outcome.kind === 'invalid') return <>{outcome.problems.map((p) => <p key={p} role="alert" className="error" data-testid={`bill-problem-${p}`}>{t(`collections.bill.problem.${p}`, locale)}</p>)}</>;
  if (outcome.kind === 'off') return <p role="alert" className="error" data-testid="bill-off">{t('allowances.off', locale)}</p>;
  return <p role="alert" className="error" data-testid="bill-error">{t(outcome.code === 'FORBIDDEN' || outcome.code === 'NOT_FOUND' ? 'error.forbidden' : 'error.generic', locale)}</p>;
}

export function BillMembers({ market, today, locale }: { market: 'IL' | 'US'; today: string; locale: Locale }) {
  const router = useRouter();
  const [draft, setDraft] = useState<BillDraft>({ description: '', amountText: '', dueDate: today });
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<BillOutcome | undefined>();
  const field = (k: keyof BillDraft, label: CopyKey, extra: Record<string, string> = {}) => (
    <label style={{ display: 'block', marginBottom: 8 }}>
      {t(label, locale)}
      <br />
      <input value={draft[k]} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} data-testid={`bill-${k}`} style={{ width: '100%', padding: 6 }} {...extra} />
    </label>
  );
  const submit = async () => {
    setBusy(true);
    const o = await billMembers(deps, draft, market, today);
    setBusy(false);
    setOutcome(o);
    if (o.kind === 'done') router.push(`/collections?month=${o.batch.dueDate.slice(0, 7)}`);
  };
  return (
    <div className="card">
      {field('description', 'collections.bill.description', { maxLength: '120' })}
      {field('amountText', market === 'US' ? 'collections.bill.amount.usd' : 'collections.bill.amount', { inputMode: 'decimal', dir: 'ltr' })}
      {field('dueDate', 'collections.bill.due', { type: 'date', min: today, dir: 'ltr' })}
      <p className="muted">{t('collections.bill.members', locale)}</p>
      <button className="primary" type="button" disabled={busy} onClick={() => void submit()} data-testid="bill-submit">{t('collections.bill.submit', locale)}</button>
      <Problem outcome={outcome} locale={locale} />
    </div>
  );
}
