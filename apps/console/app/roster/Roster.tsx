'use client';
// I04's table (T-0639): selection that survives paging (kept for this browser tab), and "Place in cohort" for the
// selected rows in one all-or-none call that keeps its key for a retry. The decisions live in src/roster.ts.
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { t, type CopyKey, type Locale } from '../../src/i18n.ts';
import { attemptFor, balanceText, cardKey, errorKey, placedText, toggle, type Attempt, type RosterMember } from '../../src/roster.ts';
import { placeInCohort } from './actions.ts';

const STORE = 'kesher-roster-selection';
const load = (): Set<string> => {
  try {
    return new Set(JSON.parse(sessionStorage.getItem(STORE) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
};
const save = (s: ReadonlySet<string>) => {
  try {
    sessionStorage.setItem(STORE, JSON.stringify([...s]));
  } catch {
    // A private window without storage keeps the selection for this page only.
  }
};

export function RosterTable({ locale, rows, cohorts }: { locale: Locale; rows: readonly RosterMember[]; cohorts: { id: string; name: string }[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [cohortId, setCohortId] = useState('');
  const [attempt, setAttempt] = useState<Attempt | undefined>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ key: CopyKey; vars?: Record<string, number>; error?: boolean } | undefined>();
  useEffect(() => setSelected(load()), []);
  const pick = (id: string) => {
    const next = toggle(selected, id);
    setSelected(next);
    save(next);
  };
  const place = async () => {
    if (!cohortId || selected.size === 0) return setMessage({ key: 'roster.place.invalid', error: true });
    const a = attemptFor(attempt, cohortId, selected, () => crypto.randomUUID());
    setAttempt(a);
    setBusy(true);
    const r = await placeInCohort(cohortId, [...selected], a.key);
    setBusy(false);
    if (!r.ok) return setMessage({ key: errorKey(r.code), error: true });
    setMessage(placedText(selected.size, r.value.placed));
    setAttempt(undefined);
    setSelected(new Set());
    save(new Set());
    router.refresh();
  };
  return (
    <>
      <div className="card row">
        <span data-testid="roster-selected">{t('roster.selected', locale, { count: selected.size })}</span>
        <select value={cohortId} onChange={(e) => setCohortId(e.target.value)} data-testid="roster-place-cohort">
          <option value="">{t('roster.place.choose', locale)}</option>
          {cohorts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <button type="button" disabled={busy} onClick={() => void place()} data-testid="roster-place">{t('roster.place', locale)}</button>
        {message ? <p role={message.error ? 'alert' : 'status'} className={message.error ? 'error' : undefined} data-testid="roster-message">{t(message.key, locale, message.vars)}</p> : null}
      </div>
      <table data-testid="roster-table">
        <thead>
          <tr>
            <td />
            <td>{t('roster.col.name', locale)}</td>
            <td>{t('roster.col.status', locale)}</td>
            <td>{t('roster.col.cohort', locale)}</td>
            <td>{t('roster.col.card', locale)}</td>
            <td>{t('roster.col.balance', locale)}</td>
            <td>{t('roster.col.plan', locale)}</td>
          </tr>
        </thead>
        <tbody>
          {rows.map((m) => (
            <tr key={m.id} data-testid={`roster-row-${m.id}`}>
              <td><input type="checkbox" checked={selected.has(m.id)} onChange={() => pick(m.id)} aria-label={m.name} /></td>
              <td><a href={`/roster/${m.id}`}>{m.name}</a></td>
              <td>{t(`roster.status.${m.status}`, locale)}</td>
              <td>{m.cohort?.name ?? ''}</td>
              <td>{t(cardKey(m), locale)}</td>
              <td dir="ltr">{balanceText(m, locale)}</td>
              <td>{m.planCode ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
