// A01 Customer 360: identity (masked), KYC, memberships, balances, cards, open cases, consents,
// assistant grants and the audit trail. Everything the member or a merchant typed is text.
import { notFound } from 'next/navigation';
import { customer360 } from '../../../src/customers/customer360.ts';
import { getAdminData } from '../../../src/data/index.ts';

export default async function CustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const record = await (await getAdminData()).getCustomer(id);
  if (!record) notFound();
  const v = customer360(record, new Date());
  return (
    <>
      <h1>
        {v.displayName} <span className="muted">· {v.mode}</span>
      </h1>
      <p>
        {v.flags.map((f) => (
          <span key={f} className={`tag ${f === 'open_case' || f === 'past_due' ? 'amber' : 'red'}`} style={{ marginRight: 6 }}>
            {f}
          </span>
        ))}
      </p>
      <div className="grid">
        <div className="card">
          <h2>Identity</h2>
          <dl>
            <dt>Phone</dt>
            <dd>{v.phoneMasked}</dd>
            <dt>Email</dt>
            <dd>{v.emailMasked ?? '—'}</dd>
            <dt>Locale</dt>
            <dd>{v.locale}</dd>
            <dt>Member since</dt>
            <dd>{v.memberSince}</dd>
            <dt>KYC</dt>
            <dd>
              {v.kyc.status} {v.kyc.tier ? `· ${v.kyc.tier}` : ''} {v.kyc.provider ? `· ${v.kyc.provider}` : ''} {v.kyc.checkedAt ? `· ${v.kyc.checkedAt.slice(0, 10)}` : ''}
            </dd>
            <dt>Party id</dt>
            <dd>
              <code>{v.partyId}</code>
            </dd>
          </dl>
        </div>
        <div className="card">
          <h2>Balances</h2>
          <table>
            <thead>
              <tr>
                <th>Account</th>
                <th>Available</th>
                <th>Holds</th>
                <th>Total</th>
              </tr>
            </thead>
            <tbody>
              {v.balances.map((b) => (
                <tr key={b.id}>
                  <td>{b.currency}</td>
                  <td>{b.available}</td>
                  <td>{b.holds}</td>
                  <td>{b.total}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="card">
          <h2>Memberships</h2>
          {v.memberships.length === 0 ? <p className="muted">None</p> : null}
          {v.memberships.map((m) => (
            <p key={m.id}>
              <strong>{m.planCode}</strong> <span className={`tag ${m.status === 'active' ? 'green' : 'amber'}`}>{m.status}</span>
              <br />
              <span className="muted">
                {m.funderName ? `Funded by ${m.funderName}` : ''} {m.institutionName ? `· ${m.institutionName}` : ''} {m.currentPeriodEnd ? `· until ${m.currentPeriodEnd.slice(0, 10)}` : ''}
              </span>
            </p>
          ))}
        </div>
        <div className="card">
          <h2>Cards</h2>
          {v.cards.length === 0 ? <p className="muted">None</p> : null}
          {v.cards.map((c) => (
            <p key={c.id}>
              {c.type} ····{c.last4} <span className={`tag ${c.status === 'active' ? 'green' : c.status === 'frozen' ? 'red' : ''}`}>{c.status}</span> <span className="muted">· {c.tokens} wallet token(s)</span>
            </p>
          ))}
        </div>
        <div className="card">
          <h2>Open cases</h2>
          {v.openCases.length === 0 ? <p className="muted">None</p> : null}
          {v.openCases.map((k) => (
            <p key={k.id}>
              <span className={`tag ${k.severity}`}>{k.severity}</span> {k.kind} · {k.status} · opened {k.openedAt.slice(0, 10)}
            </p>
          ))}
        </div>
        <div className="card">
          <h2>Consents</h2>
          {v.consents.map((c) => (
            <p key={`${c.document}-${c.version}`}>
              {c.document} <code>{c.version}</code> <span className="muted">accepted {c.acceptedAt.slice(0, 10)}</span> · <a href={`/legal/${c.document}/${c.version}.pdf`}>PDF</a>
            </p>
          ))}
        </div>
        <div className="card">
          <h2>Assistants</h2>
          {v.activeGrants.length === 0 ? <p className="muted">None</p> : null}
          {v.activeGrants.map((g) => (
            <p key={g.id}>
              {g.clientName} <span className="muted">· {g.scopes.join(', ')} · last used {g.lastUsedAt ? g.lastUsedAt.slice(0, 16).replace('T', ' ') : 'never'}</span>
            </p>
          ))}
        </div>
      </div>
      <h2>Audit trail</h2>
      <table>
        <thead>
          <tr>
            <th>When</th>
            <th>Actor</th>
            <th>Action</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          {v.audit.map((a, i) => (
            <tr key={i}>
              <td>{a.at.slice(0, 16).replace('T', ' ')}</td>
              <td>{a.actor}</td>
              <td>{a.action}</td>
              <td>{a.detail ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
