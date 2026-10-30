// An institution's KYB review (T-0926, REQ-INS-010, REQ-INS-011, ADR-017):
// - the decision and what each money capability does under it;
// - the people, with their KYC tier;
// - every check, with its result and evidence reference;
// - Dispose on each open hit;
// - Decide, with every blocking reason in words before anything is sent;
// - Approve for the second reviewer of a high-risk approval, never its proposer.
// Support reads the page with no buttons. Names and notes are staff text, shown as text. No document is uploaded
// or shown: only the reference to where the evidence is kept.
import { randomUUID } from 'node:crypto';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getAdminData } from '../../../../src/data/index.ts';
import { blockingWords, canApprove, canDispose, capabilities, decisionProblem, decisionProblemWords, isCompliance, kindWords, kybErrorWords, STATUS_WORDS, subjectOf } from '../../../../src/institutions/kyb.ts';
import { currentActor } from '../../../../src/ui/actor.ts';

const DONE: Record<string, string> = {
  disposed: 'Disposed of. The record below shows the outcome.',
  decided: 'Decided. The institution’s capabilities below follow the new decision.',
  awaiting_second_approval: 'Proposed. A high-risk approval waits for a second compliance member.',
  approved: 'Approved by a second compliance member.',
};

export default async function KybPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { id } = await params;
  const sp = await searchParams;
  const actor = await currentActor();
  const data = await getAdminData();
  const [inst, k] = await Promise.all([data.getInstitution(id, actor), data.getKyb(id, actor)]);
  if (!inst || !k) notFound();
  const one = (key: string) => (typeof sp[key] === 'string' ? sp[key] : undefined);
  const error = kybErrorWords(one('error'));
  const problems = (one('problem') ?? '').split(',').map((p) => decisionProblem(p)).filter((p) => p !== undefined);
  const done = DONE[one('done') ?? ''];
  const action = `/institutions/${encodeURIComponent(inst.id)}/kyb/actions`;
  const compliance = isCompliance(actor);
  return (
    <>
      <p>
        <Link href={`/institutions/${encodeURIComponent(inst.id)}`}>← {inst.name}</Link>
      </p>
      <h1>
        KYB · {inst.name} <span className="tag">{inst.market}</span>
      </h1>
      {error ? (
        <p className="tag red" role="alert">
          {error}
        </p>
      ) : null}
      {done ? (
        <p className="tag green" role="status">
          {done}
        </p>
      ) : null}

      <div className="grid">
        <div className="card" data-testid="kyb-decision">
          <h2>Decision</h2>
          <p>
            <strong>{STATUS_WORDS[k.decision.status]}</strong>
            {k.decision.risk ? ` · ${k.decision.risk} risk` : null}
            {k.decision.decidedAt ? <span className="muted"> · {k.decision.decidedAt.slice(0, 10)}</span> : null}
          </p>
          {k.decision.reasons.length ? <p className="muted">{k.decision.reasons.join('; ')}</p> : null}
          <ul>
            {capabilities(k).map((c) => (
              <li key={c.capability}>
                <span className={`tag ${c.open ? 'green' : 'red'}`}>{c.open ? 'open' : 'closed'}</span> {c.capability}
                {c.why ? <span className="muted"> · {c.why}</span> : null}
              </li>
            ))}
          </ul>
        </div>
        <div className="card">
          <h2>People</h2>
          {k.people.length === 0 ? (
            <p className="muted">No one is named yet.</p>
          ) : (
            <ul>
              {k.people.map((p) => (
                <li key={p.id}>
                  {p.fullName} · {p.roles.join(', ')} · <span className={`tag ${p.kycTier === 'T2' ? 'green' : 'amber'}`}>{p.kycTier ?? 'no KYC'}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <h2>Checks</h2>
      <table>
        <thead>
          <tr>
            <th>Check</th>
            <th>About</th>
            <th>Result</th>
            <th>Evidence</th>
            <th>Checked</th>
            <th>Disposition</th>
          </tr>
        </thead>
        <tbody>
          {k.checks.map((c) => (
            <tr key={c.id}>
              <td>{kindWords(c.kind)}</td>
              <td>{subjectOf(k, c.personId)}</td>
              <td>
                <span className={`tag ${c.result === 'clear' ? 'green' : c.result === 'hit' ? 'red' : 'amber'}`}>{c.result}</span>
              </td>
              <td>
                {c.provider}
                {c.evidenceRef ? ` · ${c.evidenceRef}` : null}
              </td>
              <td>{c.checkedAt.slice(0, 10)}</td>
              <td>
                {c.disposition ? (
                  <>
                    <span className={`tag ${c.disposition.outcome === 'true_match' ? 'red' : 'green'}`}>{c.disposition.outcome.replace('_', ' ')}</span> {c.disposition.note}
                  </>
                ) : canDispose(c, actor) ? (
                  <form method="post" action={action} className="inline" aria-label={`Dispose of the ${kindWords(c.kind)} hit on ${subjectOf(k, c.personId)}`}>
                    <input type="hidden" name="action" value="dispose" />
                    <input type="hidden" name="checkId" value={c.id} />
                    <select name="outcome" defaultValue="false_positive" aria-label="Outcome">
                      <option value="false_positive">False positive</option>
                      <option value="true_match">True match</option>
                    </select>{' '}
                    <input name="note" placeholder="Why" required maxLength={1000} aria-label="Note" />{' '}
                    <button type="submit">Dispose</button>
                  </form>
                ) : c.result === 'hit' ? (
                  <span className="muted">Open: compliance disposes of it</span>
                ) : (
                  '—'
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {k.pendingApproval ? (
        <div className="card" data-testid="kyb-pending">
          <h2>Waiting for a second reviewer</h2>
          <p>
            {STATUS_WORDS[k.pendingApproval.outcome]} at {k.pendingApproval.risk ?? 'high'} risk, proposed{k.pendingApproval.proposedByMe ? ' by you' : ''}.
          </p>
          {canApprove(k, actor) ? (
            <form method="post" action={action}>
              <input type="hidden" name="action" value="approve" />
              <input type="hidden" name="approvalId" value={k.pendingApproval.id} />
              <button type="submit" className="primary">
                Approve
              </button>
            </form>
          ) : (
            <p className="muted">{k.pendingApproval.proposedByMe ? 'You proposed it, so a different compliance member approves it.' : 'Only Kesher compliance approves it.'}</p>
          )}
        </div>
      ) : null}

      <h2>Decide</h2>
      {k.blocking.length ? (
        <div className="card" data-testid="kyb-blocking">
          <p>An approval is refused while these stand:</p>
          <ul>
            {k.blocking.map((code) => (
              <li key={code} className="tag amber">
                {blockingWords(k, code)}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="muted">Nothing blocks an approval.</p>
      )}
      {compliance ? (
        <form method="post" action={action} className="card" aria-label="Decide">
          <input type="hidden" name="action" value="decide" />
          <input type="hidden" name="key" value={randomUUID()} />
          <div className="grid">
            <label>
              Outcome
              <br />
              <select name="status" defaultValue="approved" aria-invalid={problems.includes('status')}>
                {Object.entries(STATUS_WORDS).map(([value, words]) => (
                  <option key={value} value={value}>
                    {words}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Risk (approvals)
              <br />
              <select name="risk" defaultValue="" aria-invalid={problems.includes('risk')}>
                <option value="">—</option>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High: a second reviewer approves</option>
              </select>
            </label>
            <label>
              Reasons, one per line
              <br />
              <textarea name="reasons" rows={3} maxLength={2000} aria-invalid={problems.includes('reasons')} />
            </label>
          </div>
          {problems.length ? (
            <ul role="alert">
              {problems.map((p) => (
                <li key={p} className="tag red">
                  {decisionProblemWords(p)}
                </li>
              ))}
            </ul>
          ) : null}
          <p>
            <button type="submit" className="primary">
              Decide
            </button>
          </p>
        </form>
      ) : (
        <p className="muted">Only Kesher compliance disposes of hits and decides KYB.</p>
      )}
    </>
  );
}
