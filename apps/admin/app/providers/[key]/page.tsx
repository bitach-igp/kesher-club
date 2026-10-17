// One flag: the switch-on checklist (release gates), the two-person flip, and the kill switch.
import { notFound } from 'next/navigation';
import { getAdminData } from '../../../src/data/memory.ts';
import { isMoneyFlag } from '../../../src/providers/money-flags.ts';
import { APPROVALS_REQUIRED, evaluateFlip, gatesFor } from '../../../src/providers/release-gates.ts';
import { currentActor } from '../../../src/ui/actor.ts';

export default async function FlagPage({ params, searchParams }: { params: Promise<{ key: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { key } = await params;
  const sp = await searchParams;
  const flag = await getAdminData().getFlag(key);
  if (!flag) notFound();
  const actor = await currentActor();
  const gates = gatesFor(key);
  const pending = flag.pendingFlip;
  const evaluation = evaluateFlip(key, flag.gatesTicked, pending?.approvals ?? [], pending?.to ?? true);
  const error = typeof sp['error'] === 'string' ? sp['error'] : undefined;
  const base = `/providers/${encodeURIComponent(key)}`;
  return (
    <>
      <h1>
        {key} <span className={`tag ${flag.on ? 'green' : ''}`}>{flag.on ? 'on' : 'off'}</span> {isMoneyFlag(key) ? <span className="tag red">money</span> : null}
      </h1>
      {error ? (
        <p className="tag red" role="alert">
          {error}
        </p>
      ) : null}
      <p className="muted">{flag.lastChangedAt ? `Last changed ${flag.lastChangedAt.slice(0, 16).replace('T', ' ')} by ${flag.lastChangedBy}` : 'Never changed'}</p>
      <div className="grid">
        <div className="card">
          <h2>
            Switch-on checklist · {flag.gatesTicked.length}/{gates.length}
          </h2>
          {gates.map((g) => {
            const ticked = flag.gatesTicked.includes(g.id);
            return (
              <form key={g.id} method="post" action={`${base}/gate`} style={{ display: 'flex', gap: 8, alignItems: 'baseline', marginBottom: 6 }}>
                <input type="hidden" name="gate" value={g.id} />
                <input type="hidden" name="ticked" value={ticked ? 'false' : 'true'} />
                <button type="submit" aria-pressed={ticked} aria-label={`${ticked ? 'Untick' : 'Tick'}: ${g.label}`}>
                  {ticked ? '☑' : '☐'}
                </button>
                <span>
                  {g.label}
                  <br />
                  <span className="muted">{g.evidence}</span>
                </span>
              </form>
            );
          })}
          <p>
            <span className="muted">Last gate: </span>
            {APPROVALS_REQUIRED} admins approve the flip in this console.
          </p>
        </div>
        <div className="card">
          <h2>Flip</h2>
          {pending ? (
            <>
              <p>
                Proposed <strong>{pending.to ? 'on' : 'off'}</strong> by {pending.requestedBy} at {pending.requestedAt.slice(0, 16).replace('T', ' ')} · approvals {pending.approvals.length}/{APPROVALS_REQUIRED}
              </p>
              {pending.approvals.includes(actor.subject) ? (
                <p className="muted">You proposed this. A different admin must give the second approval.</p>
              ) : (
                <form method="post" action={`${base}/flip`}>
                  <input type="hidden" name="action" value="approve" />
                  <button className="primary" type="submit" disabled={!evaluation.gatesComplete}>
                    Approve and apply
                  </button>
                </form>
              )}
            </>
          ) : (
            <form method="post" action={`${base}/flip`}>
              <input type="hidden" name="action" value="propose" />
              <input type="hidden" name="to" value={flag.on ? 'false' : 'true'} />
              <button className="primary" type="submit" disabled={!flag.on && !evaluation.gatesComplete}>
                Propose turning {flag.on ? 'off' : 'on'}
              </button>
              {!flag.on && !evaluation.gatesComplete ? <p className="muted">Missing gates: {evaluation.missing.join(', ')}</p> : null}
            </form>
          )}
        </div>
        <div className="card">
          <h2>Kill switch</h2>
          <p className="muted">Turns the flag off now. One admin. Audited. Use it for RUN-01 provider outages and RUN-06 agent abuse.</p>
          <form method="post" action={`${base}/kill`}>
            <button className="danger" type="submit" disabled={!flag.on}>
              Turn {key} off now
            </button>
          </form>
        </div>
      </div>
    </>
  );
}
