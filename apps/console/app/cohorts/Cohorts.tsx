'use client';
// I03's form (T-0637): checks the dates first, keeps the attempt's key until the cohort lands.
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { attemptFor, cohortProblem, errorKey, type Attempt, type CohortForm } from '../../src/cohorts.ts';
import { t, type CopyKey, type Locale } from '../../src/i18n.ts';
import { createCohort } from './actions.ts';

export function NewCohort({ locale }: { locale: Locale }) {
  const router = useRouter();
  const [form, setForm] = useState<CohortForm>({ name: '', startsOn: '', endsOn: '' });
  const [attempt, setAttempt] = useState<Attempt | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<CopyKey | undefined>();
  const submit = async () => {
    const problem = cohortProblem(form);
    if (problem) return setError(problem.key);
    const a = attemptFor(attempt, form, () => crypto.randomUUID());
    setAttempt(a);
    setBusy(true);
    setError(undefined);
    const r = await createCohort({ name: form.name.trim(), startsOn: form.startsOn, endsOn: form.endsOn }, a.key);
    setBusy(false);
    if (!r.ok) return setError(errorKey(r.code));
    setAttempt(undefined);
    setForm({ name: '', startsOn: '', endsOn: '' });
    router.refresh();
  };
  return (
    <div className="card">
      <h2>{t('cohorts.new', locale)}</h2>
      <div className="row">
        <label>
          {t('cohorts.form.nameLabel', locale)}
          <br />
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} data-testid="cohort-name" />
        </label>
        <label>
          {t('cohorts.form.start', locale)}
          <br />
          <input type="date" value={form.startsOn} onChange={(e) => setForm({ ...form, startsOn: e.target.value })} data-testid="cohort-start" />
        </label>
        <label>
          {t('cohorts.form.end', locale)}
          <br />
          <input type="date" value={form.endsOn} onChange={(e) => setForm({ ...form, endsOn: e.target.value })} data-testid="cohort-end" />
        </label>
      </div>
      <button className="primary" type="button" disabled={busy} onClick={() => void submit()} data-testid="cohort-submit">{t('cohorts.form.submit', locale)}</button>
      {error ? <p role="alert" className="error" data-testid="cohort-error">{t(error, locale)}</p> : null}
    </div>
  );
}
