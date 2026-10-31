'use client';
// I01's interactive half (T-0633): the three steps and Submit. The decisions (validation, which steps are done,
// when Submit is offered, which key a write goes with, how a refusal reads) live in src/apply.ts; this renders
// them. Names the applicant types are shown back as text.
import { useRef, useState, type ReactNode } from 'react';
import { accountBody, accountProblem, canSubmit, entityProblem, errorKey, keyFor, signatoryProblem, statusKey, steps, toRequest, type AccountForm, type Application, type EntityForm, type PersonRole, type Problem, type SignatoryForm } from '../../src/apply.ts';
import { t, type CopyKey, type Locale } from '../../src/i18n.ts';
import * as actions from './actions.ts';
import type { ApplyResult } from './actions.ts';

const ROLES: readonly PersonRole[] = ['signatory', 'control', 'board'];
const newKey = () => crypto.randomUUID();

function Field({ label, value, onChange, testId, ltr }: { label: string; value: string; onChange: (v: string) => void; testId: string; ltr?: boolean }) {
  return (
    <label style={{ display: 'block', marginBottom: 8 }}>
      {label}
      <br />
      <input value={value} onChange={(e) => onChange(e.target.value)} data-testid={testId} {...(ltr ? { dir: 'ltr' } : {})} style={{ width: '100%', padding: 6 }} />
    </label>
  );
}

function Step({ title, done, locale, children }: { title: CopyKey; done: boolean; locale: Locale; children: ReactNode }) {
  return (
    <div className="card">
      <h2>
        {t(title, locale)} {done ? <span className="muted">· {t('apply.step.done', locale)}</span> : null}
      </h2>
      {children}
    </div>
  );
}

export function Apply({ locale, initial }: { locale: Locale; initial: Application | undefined }) {
  const [app, setApp] = useState<Application | undefined>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<CopyKey | undefined>();
  const pending = useRef(new Map<string, string>());
  const [entity, setEntity] = useState<EntityForm>({ legalName: '', market: 'IL', registrationNumber: '', line1: '', city: '', postalCode: '' });
  const [person, setPerson] = useState<SignatoryForm>({ fullName: '', roles: ['signatory'], self: false });
  const [account, setAccount] = useState<AccountForm>({ holderName: '', iban: '', routingNumber: '', accountNumber: '' });

  /** Runs one write: checks first, keeps the key until it lands, reads a refusal as a sentence. */
  const write = async (problem: Problem, change: unknown, call: (key: string) => Promise<ApplyResult>, after?: () => void) => {
    if (problem) return setError(problem.key);
    setBusy(true);
    setError(undefined);
    const k = keyFor(pending.current, change, newKey);
    const r = await call(k.key);
    setBusy(false);
    if (!r.ok) return setError(errorKey(r.code, r.problems));
    pending.current.delete(k.change);
    setApp(r.value);
    after?.();
  };

  const done = steps(app);
  const editable = !app || app.editable;
  return (
    <>
      {app ? (
        <div className="card" role="status" data-testid="apply-status">
          <strong>{t(statusKey(app), locale)}</strong>
          {app.reviewerNote?.length ? (
            <>
              <p>{t('apply.note', locale)}</p>
              <ul data-testid="apply-note">{app.reviewerNote.map((n) => <li key={n}>{n}</li>)}</ul>
            </>
          ) : null}
        </div>
      ) : null}
      {error ? <p role="alert" className="error" data-testid="apply-error">{t(error, locale)}</p> : null}

      <Step title="apply.step.entity" done={done.entity} locale={locale}>
        {app ? (
          <p data-testid="apply-entity">{app.legalName} · {app.registrationNumber} · {app.address.line1}, {app.address.city} {app.address.postalCode}</p>
        ) : (
          <>
            <Field label={t('apply.entity.legalName', locale)} value={entity.legalName} onChange={(v) => setEntity({ ...entity, legalName: v })} testId="apply-legal-name" />
            <label style={{ display: 'block', marginBottom: 8 }}>
              {t('apply.entity.market', locale)}
              <br />
              <select value={entity.market} onChange={(e) => setEntity({ ...entity, market: e.target.value as 'IL' | 'US' })} data-testid="apply-market">
                <option value="IL">{t('apply.entity.market.IL', locale)}</option>
                <option value="US">{t('apply.entity.market.US', locale)}</option>
              </select>
            </label>
            <Field label={t('apply.entity.registration', locale)} value={entity.registrationNumber} onChange={(v) => setEntity({ ...entity, registrationNumber: v })} testId="apply-registration" ltr />
            <Field label={t('apply.entity.line1', locale)} value={entity.line1} onChange={(v) => setEntity({ ...entity, line1: v })} testId="apply-line1" />
            <Field label={t('apply.entity.city', locale)} value={entity.city} onChange={(v) => setEntity({ ...entity, city: v })} testId="apply-city" />
            <Field label={t('apply.entity.postalCode', locale)} value={entity.postalCode} onChange={(v) => setEntity({ ...entity, postalCode: v })} testId="apply-postal" ltr />
            <button className="primary" type="button" disabled={busy} onClick={() => void write(entityProblem(entity), { create: toRequest(entity) }, (key) => actions.createApplication(toRequest(entity), key))} data-testid="apply-create">
              {t('apply.entity.save', locale)}
            </button>
          </>
        )}
      </Step>

      {app ? (
        <Step title="apply.step.people" done={done.signatories} locale={locale}>
          {app.signatories.length ? (
            <ul data-testid="apply-people">
              {app.signatories.map((s) => <li key={s.id}>{s.fullName} · {s.roles.map((r) => t(`apply.people.role.${r}`, locale)).join(', ')}</li>)}
            </ul>
          ) : null}
          {!done.signatories ? <p className="muted">{t('apply.people.needSignatory', locale)}</p> : null}
          {editable ? (
            <>
              <Field label={t('apply.people.name', locale)} value={person.fullName} onChange={(v) => setPerson({ ...person, fullName: v })} testId="apply-person-name" />
              <div className="row" style={{ marginBottom: 8 }}>
                {ROLES.map((r) => (
                  <label key={r}>
                    <input type="checkbox" checked={person.roles.includes(r)} onChange={(e) => setPerson({ ...person, roles: e.target.checked ? [...person.roles, r] : person.roles.filter((x) => x !== r) })} data-testid={`apply-role-${r}`} /> {t(`apply.people.role.${r}`, locale)}
                  </label>
                ))}
                <label>
                  <input type="checkbox" checked={person.self} onChange={(e) => setPerson({ ...person, self: e.target.checked })} data-testid="apply-person-self" /> {t('apply.people.self', locale)}
                </label>
              </div>
              <button type="button" disabled={busy} data-testid="apply-person-add" onClick={() => void write(signatoryProblem(person), { person, id: app.id }, (key) => actions.addSignatory(app.id, { fullName: person.fullName.trim(), roles: person.roles, ...(person.self ? { self: true } : {}) }, key), () => setPerson({ fullName: '', roles: ['signatory'], self: false }))}>
                {t('apply.people.add', locale)}
              </button>
            </>
          ) : null}
        </Step>
      ) : null}

      {app ? (
        <Step title="apply.step.account" done={done.account} locale={locale}>
          {app.account ? <p data-testid="apply-account">{t('apply.account.current', locale, { masked: app.account.masked, holder: app.account.holderName })}</p> : null}
          {editable ? (
            <>
              <Field label={t('apply.account.holder', locale)} value={account.holderName} onChange={(v) => setAccount({ ...account, holderName: v })} testId="apply-holder" />
              {app.market === 'IL' ? (
                <Field label={t('apply.account.iban', locale)} value={account.iban} onChange={(v) => setAccount({ ...account, iban: v })} testId="apply-iban" ltr />
              ) : (
                <>
                  <Field label={t('apply.account.routing', locale)} value={account.routingNumber} onChange={(v) => setAccount({ ...account, routingNumber: v })} testId="apply-routing" ltr />
                  <Field label={t('apply.account.number', locale)} value={account.accountNumber} onChange={(v) => setAccount({ ...account, accountNumber: v })} testId="apply-account-number" ltr />
                </>
              )}
              <button type="button" disabled={busy} data-testid="apply-account-save" onClick={() => void write(accountProblem(app.market, account), { account, id: app.id }, () => actions.proposeAccount(app.id, accountBody(app.market, account)))}>
                {t('apply.account.save', locale)}
              </button>
            </>
          ) : null}
        </Step>
      ) : null}

      {app && app.editable ? (
        <div className="card">
          <button className="primary" type="button" disabled={busy || !canSubmit(app)} data-testid="apply-submit" onClick={() => void write(undefined, { submit: app.id }, () => actions.submitApplication(app.id))}>
            {t('apply.submit', locale)}
          </button>
          {!canSubmit(app) ? <p className="muted">{t('apply.submit.hint', locale)}</p> : null}
        </div>
      ) : null}
    </>
  );
}
