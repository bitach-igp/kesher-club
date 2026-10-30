// A05 Catalogue and pricing (T-0929, REQ-MKT-002, REQ-ADM-003): the add-on price rules, newest first, with the
// price each would charge for a sample cost. Kesher finance proposes a rule; a different finance member approves
// it (it prices the next catalogue sync) or rejects it with a reason. Support reads and changes nothing.
import { money } from '@kesher/domain';
import { canDecide, errorWords, isFinance, KINDS, problemWords, ruleProblem, workedPrice } from '../../src/catalogue/view.ts';
import { getAdminData } from '../../src/data/index.ts';
import { money$ } from '../../src/institutions/view.ts';
import { currentActor } from '../../src/ui/actor.ts';

/** A sample vendor cost for the worked price: the simulator's smallest Israel eSIM. */
const SAMPLE_COST_MINOR = 950n;

export default async function CataloguePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const actor = await currentActor();
  const rules = await (await getAdminData()).listPriceRules();
  const one = (k: string) => (typeof sp[k] === 'string' ? sp[k] : undefined);
  const error = errorWords(one('error'));
  const problems = (one('problem') ?? '').split(',').map(ruleProblem).filter((p) => p !== undefined);
  const done = one('done');
  return (
    <>
      <h1>Catalogue and pricing</h1>
      <p className="muted">Prices come only from these rules: price = max(floor, vendor cost × (1 + margin)), rounded up to .99 when the rule says so. The lowest priority number among matching rules wins. A rule takes two Kesher finance members, and the next catalogue sync prices with it.</p>
      {error ? (
        <p className="tag red" role="alert">
          {error}
        </p>
      ) : null}
      {done ? (
        <p className="tag green" role="status">
          {done === 'proposed' ? 'Proposed. A different finance member approves it before it prices anything.' : done === 'approve' ? 'Approved: the rule is active from the next catalogue sync.' : 'Rejected. It will never price anything.'}
        </p>
      ) : null}

      <h2>Price rules</h2>
      {rules.length === 0 ? (
        <p className="muted" data-testid="rules-none">
          No rules yet: the catalogue lists nothing until one is active.
        </p>
      ) : (
        <table data-testid="rules">
          <thead>
            <tr>
              <th>State</th>
              <th>Kind · provider · SKU</th>
              <th>Margin</th>
              <th>Floor</th>
              <th>Priority</th>
              <th>A {money$(money(SAMPLE_COST_MINOR, 'USD'))} cost sells at</th>
              <th>Why</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.id} data-testid={`rule-${r.id}`}>
                <td>
                  <span className={`tag ${r.state === 'active' ? 'green' : r.state === 'rejected' ? 'red' : 'amber'}`}>{r.state}</span>
                </td>
                <td>
                  {r.kind} · {r.provider} · <code>{r.skuPattern}</code>
                </td>
                <td>{(r.marginBps / 100).toFixed(2)}%</td>
                <td>{money$(r.floor)}</td>
                <td>{r.priority}</td>
                <td data-testid="rule-worked">{money$(workedPrice(r, money(SAMPLE_COST_MINOR, r.floor.currency)))}</td>
                <td>
                  {r.reason}
                  {r.proposedBy ? <span className="muted"> · {r.proposedBy}</span> : null}
                </td>
                <td>
                  {canDecide(r, actor) ? (
                    <>
                      <form method="post" action={`/catalogue/rules/${encodeURIComponent(r.id)}`} style={{ display: 'inline' }}>
                        <input type="hidden" name="decision" value="approve" />
                        <button type="submit" className="primary" data-testid={`approve-${r.id}`}>
                          Approve
                        </button>
                      </form>{' '}
                      <form method="post" action={`/catalogue/rules/${encodeURIComponent(r.id)}`} style={{ display: 'inline' }}>
                        <input type="hidden" name="decision" value="reject" />
                        <input name="reason" placeholder="Why not" maxLength={500} required />{' '}
                        <button type="submit">Reject</button>
                      </form>
                    </>
                  ) : r.state === 'proposed' && r.proposedBy === actor.subject ? (
                    <span className="muted">Yours: a different finance member decides it.</span>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Propose a rule</h2>
      {isFinance(actor) ? (
        <form method="post" action="/catalogue/rules" className="card" aria-label="Propose a price rule">
          <div className="grid">
            <label>
              Kind
              <br />
              <select name="kind" defaultValue="esim" aria-invalid={problems.includes('kind')}>
                {KINDS.map((k) => (
                  <option key={k.kind} value={k.kind}>
                    {k.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Provider
              <br />
              <input name="provider" placeholder="simulator" required aria-invalid={problems.includes('provider')} />
            </label>
            <label>
              Vendor SKU pattern
              <br />
              <input name="skuPattern" placeholder="^IL- (empty for all)" maxLength={120} aria-invalid={problems.includes('pattern')} />
            </label>
            <label>
              Margin, percent of cost
              <br />
              <input name="margin" inputMode="decimal" placeholder="25" required aria-invalid={problems.includes('margin')} />
            </label>
            <label>
              Floor
              <br />
              <input name="floor" inputMode="decimal" placeholder="0.00" aria-invalid={problems.includes('floor')} />
            </label>
            <label>
              Currency
              <br />
              <select name="currency" defaultValue="USD">
                <option value="USD">USD</option>
                <option value="ILS">ILS</option>
              </select>
            </label>
            <label>
              Priority
              <br />
              <input name="priority" inputMode="numeric" defaultValue="100" aria-invalid={problems.includes('priority')} />
            </label>
            <label>
              <input type="checkbox" name="roundTo99" defaultChecked /> Round up to .99
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
              Propose rule
            </button>{' '}
            <span className="muted">Nothing is priced until a different finance member approves it.</span>
          </p>
        </form>
      ) : (
        <p className="muted">Only Kesher finance proposes or decides price rules.</p>
      )}
    </>
  );
}
