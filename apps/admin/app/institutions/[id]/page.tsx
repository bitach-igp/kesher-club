// One institution (T-0615, REQ-INS-007, REQ-INS-008): the payment reference it quotes, its balances, its staff,
// and its deposits. Finance records a statement line; a different finance member approves (it posts) or
// rejects it with a reason. Support sees the page and records nothing. T-0926: its KYB decision and what each
// money capability does under it (ADR-017), with a link to the review.
import { randomUUID } from 'node:crypto';
import Link from 'next/link';
import { Fragment } from 'react';
import { notFound } from 'next/navigation';
import { getAdminData } from '../../../src/data/index.ts';
import { capabilities, STATUS_WORDS } from '../../../src/institutions/kyb.ts';
import { canDecide, errorWords, formProblem, isFinance, money$, problemWords, RAILS } from '../../../src/institutions/view.ts';
import { currentActor } from '../../../src/ui/actor.ts';

export default async function InstitutionPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { id } = await params;
  const sp = await searchParams;
  const actor = await currentActor();
  const data = await getAdminData();
  const [inst, kyb] = await Promise.all([data.getInstitution(id, actor), data.getKyb(id, actor)]);
  if (!inst) notFound();
  const one = (k: string) => (typeof sp[k] === 'string' ? sp[k] : undefined);
  const error = errorWords(one('error'));
  const problems = (one('problem') ?? '').split(',').map(formProblem).filter((p) => p !== undefined);
  const base = `/institutions/${encodeURIComponent(inst.id)}`;
  const today = new Date().toISOString().slice(0, 10);
  return (
    <>
      <h1>
        {inst.name} <span className="tag">{inst.market}</span>
      </h1>
      {error ? (
        <p className="tag red" role="alert">
          {error}
        </p>
      ) : null}
      {one('done') ? (
        <p className="tag green" role="status">
          {one('done') === 'recorded' ? 'Recorded. A different finance member approves it before it posts.' : one('done') === 'approve' ? 'Approved and posted.' : 'Rejected. Nothing posted.'}
        </p>
      ) : null}
      <div className="grid">
        <div className="card">
          <h2>Money</h2>
          <dl>
            <dt>Payment reference</dt>
            <dd>{inst.paymentReference ? <strong>{inst.paymentReference}</strong> : <span className="muted">Deposits are off</span>}</dd>
            {inst.balances.map((b) => (
              <Fragment key={b.currency}>
                <dt>Balance {b.currency}</dt>
                <dd>{money$(b)}</dd>
              </Fragment>
            ))}
          </dl>
        </div>
        {kyb ? (
          <div className="card" data-testid="institution-kyb">
            <h2>KYB · {STATUS_WORDS[kyb.decision.status]}</h2>
            <ul>
              {capabilities(kyb).map((c) => (
                <li key={c.capability}>
                  <span className={`tag ${c.open ? 'green' : 'red'}`}>{c.open ? 'open' : 'closed'}</span> {c.capability}
                  {c.why ? <span className="muted"> · {c.why}</span> : null}
                </li>
              ))}
            </ul>
            <p>
              <Link href={`${base}/kyb`}>Review KYB{kyb.blocking.length ? ` · ${kyb.blocking.length} open item(s)` : ''} →</Link>
            </p>
          </div>
        ) : null}
        <div className="card">
          <h2>Staff · {inst.activeStaff} active</h2>
          {inst.pendingGrants ? <p className="tag amber">{inst.pendingGrants} grant(s) waiting for a second admin</p> : null}
          <ul>
            {inst.staff.map((s) => (
              <li key={s.partyId}>
                {s.phoneMasked ?? s.partyId} · {s.role} {s.active ? null : <span className="muted">(removed)</span>}
              </li>
            ))}
          </ul>
        </div>
      </div>

      {inst.depositsOff ? (
        <p className="muted">The institutions.deposits flag is off: there is nothing to record yet.</p>
      ) : (
        <>
          <h2>Deposits</h2>
          {isFinance(actor) ? (
            <form method="post" action={`${base}/deposits`} className="card" aria-label="Record a deposit">
              <input type="hidden" name="key" value={randomUUID()} />
              <div className="grid">
                <label>
                  Amount
                  <br />
                  <input name="amount" inputMode="decimal" placeholder="20,000.00" required aria-invalid={problems.includes('amount')} />
                </label>
                <label>
                  Currency
                  <br />
                  <select name="currency" defaultValue={inst.market === 'US' ? 'USD' : 'ILS'} aria-invalid={problems.includes('currency')}>
                    <option value="ILS">ILS</option>
                    <option value="USD">USD</option>
                  </select>
                </label>
                <label>
                  Rail
                  <br />
                  <select name="rail" defaultValue={inst.market === 'US' ? 'ach' : 'masav'} aria-invalid={problems.includes('rail')}>
                    {RAILS.map((r) => (
                      <option key={r.rail} value={r.rail}>
                        {r.label} ({r.currencies.join(' or ')})
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Bank reference
                  <br />
                  <input name="bankReference" maxLength={64} required aria-invalid={problems.includes('reference')} />
                </label>
                <label>
                  Value date
                  <br />
                  <input name="valueDate" type="date" max={today} defaultValue={today} required aria-invalid={problems.includes('date')} />
                </label>
                <label>
                  Note (optional)
                  <br />
                  <input name="note" maxLength={500} />
                </label>
              </div>
              {problems.length ? (
                <ul role="alert">
                  {problems.map((p) => (
                    <li key={p} className="tag red">
                      {problemWords(p)}
                    </li>
                  ))}
                </ul>
              ) : null}
              <p>
                <button type="submit" className="primary">
                  Record deposit
                </button>{' '}
                <span className="muted">Nothing moves until a different finance member approves it.</span>
              </p>
            </form>
          ) : (
            <p className="muted">Only Kesher finance records or decides deposits.</p>
          )}
          {inst.deposits.length === 0 ? (
            <p className="muted">No deposits yet.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Value date</th>
                  <th>Amount</th>
                  <th>Rail · reference</th>
                  <th>Note</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {inst.deposits.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <span className={`tag ${d.status === 'posted' ? 'green' : d.status === 'rejected' ? 'red' : 'amber'}`}>{d.status}</span>
                    </td>
                    <td>{d.valueDate}</td>
                    <td>{money$(d.amount)}</td>
                    <td>
                      {d.rail} · {d.bankReference}
                    </td>
                    {/* Staff text: shown as text. */}
                    <td>{d.note ?? '—'}</td>
                    <td>
                      {canDecide(d, actor) ? (
                        <>
                          <form method="post" action={`${base}/deposits/${encodeURIComponent(d.id)}/approve`} className="inline">
                            <button type="submit" className="primary">
                              Approve and post
                            </button>
                          </form>{' '}
                          <form method="post" action={`${base}/deposits/${encodeURIComponent(d.id)}/reject`} className="inline">
                            <input name="reason" placeholder="Reason" required aria-label="Reason to reject" />{' '}
                            <button type="submit">Reject</button>
                          </form>
                        </>
                      ) : d.status === 'pending' && d.recordedByMe ? (
                        <span className="muted">Waiting for a second finance approver: you recorded this one.</span>
                      ) : (
                        <span className="muted">{d.decidedAt ? d.decidedAt.slice(0, 16).replace('T', ' ') : '—'}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </>
  );
}
