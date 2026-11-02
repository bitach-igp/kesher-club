// I11 team and roles (T-0644, REQ-INS-020): the staff with role and state — active, removed, open invites — and
// a finance or admin raise waiting for a second admin. Every staff role reads; admins manage: they invite, change
// a role and remove, a removal confirmed once; the raises go through the T-0643 API, and the person whose party id
// the grant names or who proposed it sees no Approve.
import { redirect } from 'next/navigation';
import type { Schemas } from '@kesher/sdk';
import { codeOf, institutionApi } from '../../src/api.ts';
import { getConfig } from '../../src/config.ts';
import { t } from '../../src/i18n.ts';
import { requestContext } from '../../src/request.ts';
import {
  canApprove,
  canManage,
  grantPerson,
  grantRole,
  inviteChannelKey,
  lastAdminOf,
  partyIdOf,
  roleKey,
  rowsOf,
  statusKey,
  who,
} from '../../src/team.ts';
import { Approve, ChangeRole, Invite, Remove } from './Team.tsx';

const dayOf = (iso: string): string => new Date(iso).toISOString().slice(0, 10);

export default async function TeamPage() {
  const { landing, access, locale } = await requestContext();
  if (landing.kind !== 'dashboard' || !access) redirect('/');
  const manage = canManage(landing.role);
  let team: Schemas['InstitutionTeam'];
  try {
    team = await institutionApi(getConfig().CONSOLE_API_URL, access).team(landing.institution.id);
  } catch (e) {
    if (!codeOf(e)) throw e;
    return <div className="card" role="status" data-testid="team-unavailable">{t('dash.unavailable', locale)}</div>;
  }
  const me = partyIdOf(access);
  const rows = rowsOf(team);
  return (
    <>
      <h1>{t('team.title', locale)}</h1>
      {manage ? <Invite locale={locale} /> : null}
      <h2>{t('team.people', locale)}</h2>
      <table data-testid="team-table">
        <thead>
          <tr>
            <td>{t('team.col.who', locale)}</td>
            <td>{t('team.col.role', locale)}</td>
            <td>{t('team.col.state', locale)}</td>
            {manage ? <td /> : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const id = r.kind === 'member' ? r.member.partyId : r.invite.id;
            const mine = !!me && me === id.toLowerCase();
            return (
              <tr key={id} data-testid={`team-row-${id}`}>
                <td dir="ltr">{r.kind === 'member' ? who(r.member.partyId) : t(inviteChannelKey(r.invite.channel), locale)}</td>
                <td>{t(roleKey(r.kind === 'member' ? r.member.role : r.invite.role), locale)}</td>
                <td data-testid={`team-state-${id}`}>
                  {t(r.kind === 'member' ? statusKey(r.state) : statusKey('invited'), locale)}
                  {r.kind === 'invite' ? <span className="muted"> · {t('team.invite.expires', locale, { date: dayOf(r.invite.expiresAt) })}</span> : null}
                </td>
                {manage ? (
                  <td>
                    {r.kind === 'member' && r.state === 'active' ? (
                      <>
                        {mine ? <span className="muted">{t('team.you', locale)}</span> : <ChangeRole locale={locale} partyId={id} role={r.member.role} />}
                        <br />
                        {lastAdminOf(r.member, team) ? <span className="muted" data-testid={`team-last-admin-${id}`}>{t('team.lastAdmin', locale)}</span> : <Remove locale={locale} partyId={id} label={who(id)} />}
                      </>
                    ) : null}
                  </td>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>
      <h2>{t('team.grants', locale)}</h2>
      {team.pendingGrants.length === 0 ? (
        <p className="muted">{t('team.grants.none', locale)}</p>
      ) : (
        team.pendingGrants.map((g: Schemas['ApprovalRequest']) => (
          <div className="card" key={g.id} data-testid={`team-grant-${g.id}`}>
            <strong data-testid={`team-grant-line-${g.id}`}>
              {t('team.grant.line', locale, { who: who(grantPerson(g)), role: t(roleKey(grantRole(g) ?? 'staff'), locale) })}
            </strong>
            <div className="muted">{t('allowances.requestedBy', locale, { name: who(g.requestedBy) })}</div>
            <div className="muted">{t('team.pending', locale)}</div>
            {manage && canApprove(g, me) ? <Approve locale={locale} grantId={g.id} /> : null}
          </div>
        ))
      )}
    </>
  );
}
