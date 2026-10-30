'use client';
// I07's new-schedule form (T-0627). The decisions (the amount check, the run dates, the outcome) live in
// src/allowances.ts; this renders them. A created schedule goes back to the list, where it shows its next date.
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { createSchedule, runDates, type Cadence, type ScheduleDeps, type ScheduleDraft, type ScheduleOutcome } from '../../src/allowances.ts';
import { t, type CopyKey, type Locale } from '../../src/i18n.ts';
import * as actions from './actions.ts';

const deps: ScheduleDeps = { create: actions.createSchedule, newKey: () => crypto.randomUUID() };
const CADENCES: readonly Cadence[] = ['weekly', 'monthly', 'once'];

function Problem({ outcome, locale }: { outcome: ScheduleOutcome | undefined; locale: Locale }) {
  if (!outcome || outcome.kind === 'done') return null;
  if (outcome.kind === 'invalid') return <>{outcome.problems.map((p) => <p key={p} role="alert" className="error" data-testid={`schedule-problem-${p}`}>{t(`allowances.form.problem.${p}`, locale)}</p>)}</>;
  if (outcome.kind === 'off') return <p role="alert" className="error" data-testid="schedule-off">{t('allowances.off', locale)}</p>;
  return <p role="alert" className="error" data-testid="schedule-error">{t(outcome.code === 'FORBIDDEN' || outcome.code === 'NOT_FOUND' ? 'error.forbidden' : 'error.generic', locale)}</p>;
}

export function NewSchedule({ market, today, locale }: { market: 'IL' | 'US'; today: string; locale: Locale }) {
  const router = useRouter();
  const [draft, setDraft] = useState<ScheduleDraft>({ name: '', amountText: '', cadence: 'weekly' });
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ScheduleOutcome | undefined>();
  const [first, then] = runDates(draft.cadence, today);
  const field = (k: 'name' | 'amountText', label: CopyKey, extra: Record<string, string> = {}) => (
    <label style={{ display: 'block', marginBottom: 8 }}>
      {t(label, locale)}
      <br />
      <input value={draft[k]} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} data-testid={`schedule-${k}`} style={{ width: '100%', padding: 6 }} {...extra} />
    </label>
  );
  const submit = async () => {
    setBusy(true);
    const o = await createSchedule(deps, draft, market);
    setBusy(false);
    setOutcome(o);
    if (o.kind === 'done') router.push('/allowances');
  };
  return (
    <div className="card">
      {field('name', 'allowances.form.name', { maxLength: '80' })}
      {field('amountText', market === 'US' ? 'allowances.form.amount.usd' : 'allowances.form.amount', { inputMode: 'decimal', dir: 'ltr' })}
      <label style={{ display: 'block', marginBottom: 8 }}>
        {t('allowances.form.cadence', locale)}
        <br />
        <select value={draft.cadence} onChange={(e) => setDraft({ ...draft, cadence: e.target.value as Cadence })} data-testid="schedule-cadence" style={{ padding: 6 }}>
          {CADENCES.map((c) => <option key={c} value={c}>{t(`allowances.cadence.${c}`, locale)}</option>)}
        </select>
      </label>
      <p className="muted">{t('allowances.form.cohort', locale)}</p>
      <p className="muted" data-testid="schedule-dates">{then ? t('allowances.form.dates', locale, { first: first!, then }) : t('allowances.form.date', locale, { first: first! })}</p>
      <button className="primary" type="button" disabled={busy} onClick={() => void submit()} data-testid="schedule-submit">{t('allowances.form.submit', locale)}</button>
      <Problem outcome={outcome} locale={locale} />
    </div>
  );
}
