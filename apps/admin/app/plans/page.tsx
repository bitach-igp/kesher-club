// A13 Plans (T-0933, REQ-ADM-006): every plan version by plan and market, with its state, price and term, the worked
// monthly price in both formats, and who proposed it. Kesher finance proposes a version; a different finance member
// approves it (new members join on it from its date) or rejects it with a reason. A version is never edited: a newer
// one supersedes it for new members, and members keep the version they joined on. Support reads and changes nothing.
import { getAdminData } from '../../src/data/index.ts';
import { money$ } from '../../src/institutions/view.ts';
import { byPlan, canDecide, errorWords, isFinance, MARKETS, planProblem, problemWords, stateWords, versionKey, workedMonthly } from '../../src/plans/view.ts';
import { currentActor } from '../../src/ui/actor.ts';

export default async function PlansPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const actor = await currentActor();
  const plans = byPlan(await (await getAdminData()).listPlanVersions());
  const one = (k: string) => (typeof sp[k] === 'string' ? sp[k] : undefined);
  const error = errorWords(one('error'));
  const problems = (one('problem') ?? '').split(',').map(planProblem).filter((p) => p !== undefined);
  const done = one('done');
  return (
    <>
      <h1>Plans</h1>
      <p className="muted">A plan version is what a new member joins on: its price for the term, the term, what it includes and the FX markup. It takes two Kesher finance members, and it is never edited: a newer version supersedes it for new members, and members keep the version they joined on.</p>
      {error ? (
        <p className="tag red" role="alert">
          {error}
        </p>
      ) : null}
      {done ? (
        <p className="tag green" role="status">
          {done === 'proposed' ? 'Proposed. A different finance member approves it before anyone joins on it.' : done === 'approve' ? 'Approved: new members join on it from its date.' : 'Rejected. It will never be offered.'}
        </p>
      ) : null}

      {plans.length === 0 ? <p className="muted">No plans yet: no one can join until a version is approved.</p> : null}
      {plans.map((p) => (
        <section key={p.planCode} aria-label={p.name} data-testid={`plan-${p.planCode}`}>
          <h2>
            {p.name} <span className="muted">· {p.planCode}</span> {p.market ? <span className="tag">{p.market}</span> : null}
          </h2>
          <table>
            <thead>
              <tr>
                <th>Version</th>
                <th>State</th>
                <th>Price · term</th>
                <th>A month</th>
                <th>Includes</th>
                <th>From</th>
                <th>Proposed by · why</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {p.versions.map((v) => {
                const monthly = workedMonthly(v.price, v.termMonths);
                const action = `/plans/${encodeURIComponent(versionKey(v))}`;
                return (
                  <tr key={v.version}>
                    <td>v{v.version}</td>
                    <td>
                      <span className={`tag ${v.offered ? 'green' : v.state === 'rejected' ? 'red' : v.state === 'proposed' ? 'amber' : ''}`}>{v.offered ? 'offered' : v.state}</span>
                      <br />
                      <span className="muted">{stateWords(v)}</span>
                    </td>
                    <td>
                      {money$(v.price)} · {v.termMonths} months
                    </td>
                    <td>
                      {monthly.en}
                      <br />
                      <span dir="rtl">{monthly.he}</span>
                    </td>
                    <td>
                      {Object.entries(v.entitlements).map(([k, e]) => (
                        <div key={k}>
                          {k}: {e.limit} {e.unit} / {e.period}
                        </div>
                      ))}
                      <span className="muted">FX markup {(v.fxMarkupBps / 100).toFixed(2)}%</span>
                    </td>
                    <td>{v.effectiveFrom.slice(0, 10)}</td>
                    {/* Staff text: shown as text. */}
                    <td>
                      {v.proposedBy ?? '—'}
                      {v.reason ? <span className="muted"> · {v.reason}</span> : null}
                      {v.decidedAt ? <span className="muted"> · decided {v.decidedAt.slice(0, 10)}</span> : null}
                    </td>
                    <td>
                      {canDecide(v, actor) ? (
                        <>
                          <form method="post" action={action} className="inline">
                            <input type="hidden" name="decision" value="approve" />
                            <button type="submit" className="primary">
                              Approve
                            </button>
                          </form>{' '}
                          <form method="post" action={action} className="inline">
                            <input type="hidden" name="decision" value="reject" />
                            <input name="reason" placeholder="Why not" maxLength={500} required aria-label="Reason to reject" />{' '}
                            <button type="submit">Reject</button>
                          </form>
                        </>
                      ) : v.state === 'proposed' && v.proposedBy === actor.subject ? (
                        <span className="muted">Yours: a different finance member decides it.</span>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      ))}

      <h2>Propose a version</h2>
      {isFinance(actor) ? (
        <form method="post" action="/plans/versions" className="card" aria-label="Propose a plan version">
          <div className="grid">
            <label>
              Plan code
              <br />
              <input name="planCode" placeholder="club-il" required aria-invalid={problems.includes('code')} />
            </label>
            <label>
              Name (for a new plan)
              <br />
              <input name="name" maxLength={80} placeholder="Kesher Club Israel" required aria-invalid={problems.includes('name')} />
            </label>
            <label>
              Market
              <br />
              <select name="market" defaultValue="IL" aria-invalid={problems.includes('market')}>
                {MARKETS.map((m) => (
                  <option key={m.market} value={m.market}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Price for the term
              <br />
              <input name="price" inputMode="decimal" placeholder="180.00" required aria-invalid={problems.includes('price')} />
            </label>
            <label>
              Term, months
              <br />
              <input name="termMonths" inputMode="numeric" defaultValue="10" required aria-invalid={problems.includes('term')} />
            </label>
            <label>
              eSIM data a month, GB
              <br />
              <input name="dataGb" inputMode="numeric" placeholder="5" aria-invalid={problems.includes('data')} />
            </label>
            <label>
              Concierge calls a term
              <br />
              <input name="conciergeCalls" inputMode="numeric" placeholder="3" aria-invalid={problems.includes('calls')} />
            </label>
            <label>
              FX markup, percent
              <br />
              <input name="fxMarkup" inputMode="decimal" defaultValue="0.75" aria-invalid={problems.includes('fx')} />
            </label>
            <label>
              Offered from (optional)
              <br />
              <input name="effectiveFrom" type="date" aria-invalid={problems.includes('date')} />
            </label>
            <label>
              Why
              <br />
              <input name="reason" maxLength={500} required aria-invalid={problems.includes('reason')} />
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
              Propose version
            </button>{' '}
            <span className="muted">The table shows its price a month once proposed. No one joins on it until a different finance member approves it.</span>
          </p>
        </form>
      ) : (
        <p className="muted">Only Kesher finance proposes or decides plan versions.</p>
      )}
    </>
  );
}
