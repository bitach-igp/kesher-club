'use client';
// I11's interactive half (T-0644): the invite form, a row's role change and removal (asking once to confirm), and
// a second admin's approve with a passkey. The decisions live in src/team.ts; this renders them.
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { t, type Locale } from '../../src/i18n.ts';
import {
  approveGrant,
  attemptFor,
  checkInvite,
  claimRole,
  messageText,
  removeFlow,
  removeStaff,
  ROLES,
  roleKey,
  sendInvite,
  type Attempt,
  type InviteDraft,
  type InviteProblem,
  type Outcome,
  type StaffRole,
  type TeamDeps,
} from '../../src/team.ts';
import { passkeyStepUp } from '../step-up-flow.ts';
import * as actions from './actions.ts';

const deps: TeamDeps = { invite: actions.createStaffInvite, change: actions.changeStaff, approve: actions.approveStaffGrant, stepUp: passkeyStepUp, newKey: () => crypto.randomUUID() };

function Said({ outcome, locale, tid }: { outcome: Outcome | undefined; locale: Locale; tid: string }) {
  if (outcome?.kind !== 'done') return null;
  return (
    <p role={outcome.message.error ? 'alert' : 'status'} className={outcome.message.error ? 'error' : undefined} data-testid={tid}>
      {messageText(outcome.message, locale)}
    </p>
  );
}

export function Invite({ locale }: { locale: Locale }) {
  const router = useRouter();
  const [draft, setDraft] = useState<InviteDraft>({ role: '', email: '', phone: '' });
  const [attempt, setAttempt] = useState<Attempt | undefined>();
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<InviteProblem[] | undefined>();
  const [outcome, setOutcome] = useState<Outcome | undefined>();
  const send = async () => {
    const checked = checkInvite(draft);
    if (!checked.ok) {
      setProblems(checked.problems);
      setOutcome(undefined);
      return;
    }
    const a = attemptFor(attempt, JSON.stringify(checked.body), deps.newKey);
    setAttempt(a);
    setProblems(undefined);
    setBusy(true);
    const o = await sendInvite(deps, draft, a.key);
    setBusy(false);
    setOutcome(o);
    setProblems(o.kind === 'invalid' ? o.problems : undefined);
    if (o.kind === 'done' && !o.message.error) {
      setAttempt(undefined);
      setDraft({ role: '', email: '', phone: '' });
      router.refresh();
    }
  };
  return (
    <div className="card">
      <h2 style={{ margin: '0 0 8px' }}>{t('team.invite', locale)}</h2>
      <div className="row" style={{ alignItems: 'end' }}>
        <label>
          {t('team.invite.role', locale)}
          <br />
          <select value={draft.role} disabled={busy} onChange={(e) => setDraft({ ...draft, role: e.target.value as InviteDraft['role'] })} data-testid="team-invite-role">
            <option value="">{t('team.invite.choose', locale)}</option>
            {ROLES.map((r) => <option key={r} value={r}>{t(roleKey(r), locale)}</option>)}
          </select>
        </label>
        <label>
          {t('team.invite.email', locale)}
          <br />
          <input dir="ltr" value={draft.email} disabled={busy} onChange={(e) => setDraft({ ...draft, email: e.target.value, phone: e.target.value ? '' : draft.phone })} data-testid="team-invite-email" />
        </label>
        <label>
          {t('team.invite.phone', locale)}
          <br />
          <input dir="ltr" value={draft.phone} disabled={busy} onChange={(e) => setDraft({ ...draft, phone: e.target.value, email: e.target.value ? '' : draft.email })} data-testid="team-invite-phone" />
        </label>
        <button className="primary" type="button" disabled={busy} onClick={() => void send()} data-testid="team-invite-submit">{t('team.invite.submit', locale)}</button>
      </div>
      {problems?.map((p) => <p key={p} role="alert" className="error" data-testid={`team-invite-problem-${p}`}>{t(`team.invite.problem.${p}`, locale)}</p>)}
      <Said outcome={outcome} locale={locale} tid="team-invite-message" />
    </div>
  );
}

export function ChangeRole({ locale, partyId, role: current }: { locale: Locale; partyId: string; role: StaffRole }) {
  const router = useRouter();
  const [value, setValue] = useState<StaffRole>(current);
  const [attempt, setAttempt] = useState<Attempt | undefined>();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | undefined>();
  const claim = async () => {
    if (value === current) return;
    const a = attemptFor(attempt, JSON.stringify([partyId, value]), deps.newKey);
    setAttempt(a);
    setBusy(true);
    const o = await claimRole(deps, partyId, value, a.key);
    setBusy(false);
    setOutcome(o);
    if (o.kind === 'done' && !o.message.error) router.refresh();
  };
  return (
    <>
      <select value={value} disabled={busy} onChange={(e) => { setValue(e.target.value as StaffRole); setOutcome(undefined); }} data-testid={`team-role-${partyId}`}>
        {ROLES.map((r) => <option key={r} value={r}>{t(roleKey(r), locale)}</option>)}
      </select>
      <button type="button" disabled={busy || value === current} onClick={() => void claim()} data-testid={`team-claim-${partyId}`}>{t('team.change', locale)}</button>
      <Said outcome={outcome} locale={locale} tid={`team-message-${partyId}`} />
    </>
  );
}

export function Remove({ locale, partyId, label }: { locale: Locale; partyId: string; label: string }) {
  const router = useRouter();
  const [armed, setArmed] = useState(false);
  const [attempt, setAttempt] = useState<Attempt | undefined>();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | undefined>();
  const act = (click: 'remove' | 'confirm' | 'cancel') => {
    const next = removeFlow(armed ? 'armed' : 'idle', click);
    if (next === 'go') {
      void (async () => {
        const a = attemptFor(attempt, partyId, deps.newKey);
        setAttempt(a);
        setBusy(true);
        const o = await removeStaff(deps, partyId, a.key);
        setBusy(false);
        setOutcome(o);
        setArmed(false);
        if (o.kind === 'done' && !o.message.error) router.refresh();
      })();
      return;
    }
    setArmed(next === 'armed');
    if (next === 'idle') setOutcome(undefined);
  };
  return (
    <>
      {armed ? (
        <>
          <span role="status" className="muted" data-testid={`team-removing-${partyId}`}>{t('team.remove.confirm', locale, { who: label })}</span>
          <button className="primary" type="button" disabled={busy} onClick={() => act('confirm')} data-testid={`team-confirm-${partyId}`}>{t('team.remove.yes', locale)}</button>
          <button type="button" disabled={busy} onClick={() => act('cancel')} data-testid={`team-cancel-${partyId}`}>{t('team.remove.no', locale)}</button>
        </>
      ) : (
        <button type="button" disabled={busy} onClick={() => act('remove')} data-testid={`team-remove-${partyId}`}>{t('team.remove', locale)}</button>
      )}
      <Said outcome={outcome} locale={locale} tid={`team-remove-message-${partyId}`} />
    </>
  );
}

export function Approve({ locale, grantId }: { locale: Locale; grantId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | undefined>();
  const run = async () => {
    setBusy(true);
    const o = await approveGrant(deps, grantId);
    setBusy(false);
    setOutcome(o);
    if (o.kind === 'done' && !o.message.error) router.refresh();
  };
  return (
    <>
      <button className="primary" type="button" disabled={busy} onClick={() => void run()} data-testid={`team-approve-${grantId}`}>{t('team.approve', locale)}</button>
      <Said outcome={outcome} locale={locale} tid={`team-approve-message-${grantId}`} />
    </>
  );
}
