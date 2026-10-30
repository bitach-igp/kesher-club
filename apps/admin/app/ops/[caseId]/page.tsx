// One ops case (T-0931, REQ-ADM-005, REQ-INS-015): what opened it, shown as text (a remitter's words included,
// never a link or markup), and what may be done: take it, resolve or dismiss it with a note, or, for a suspense
// credit, record it against an institution. That is T-0614's deposit, prefilled from the case and carrying its id,
// so no figure is retyped; a different finance member approves it, and the case resolves when it posts.
import { randomUUID } from 'node:crypto';
import { Fragment } from 'react';
import { notFound } from 'next/navigation';
import { getAdminData } from '../../../src/data/index.ts';
import { money$ } from '../../../src/institutions/view.ts';
import { actionsFor, depositPrefill, doneWords, errorWords, KIND_WORDS, NOTE_MAX, reasonWords, STATUS_WORDS } from '../../../src/ops/view.ts';
import { currentActor } from '../../../src/ui/actor.ts';

/** A payload value as text: strings as they are, anything else as JSON. */
const asText = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v));

export default async function OpsCasePage({ params, searchParams }: { params: Promise<{ caseId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { caseId } = await params;
  const sp = await searchParams;
  const one = (k: string) => (typeof sp[k] === 'string' ? sp[k] : undefined);
  const actor = await currentActor();
  const data = await getAdminData();
  const c = await data.getOpsCase(caseId);
  if (!c) notFound();
  const can = actionsFor(c, actor);
  const prefill = depositPrefill(c);
  const institutions = can.record ? await data.listInstitutions() : [];
  const action = `/ops/${encodeURIComponent(c.id)}/actions`;
  const error = errorWords(one('error'));
  const done = doneWords(one('done'));
  return (
    <>
      <p>
        <a href="/ops">← Ops queue</a>
      </p>
      <h1>
        {KIND_WORDS[c.kind].label} <span className={`tag ${c.severity}`}>{c.severity}</span> <span className="tag">{STATUS_WORDS[c.status]}</span>
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
      <p className="muted">{KIND_WORDS[c.kind].hint}</p>
      <div className="grid">
        <div className="card">
          <h2>{c.summary}</h2>
          {reasonWords(c.payload['reason']) ? <p>{reasonWords(c.payload['reason'])}</p> : null}
          <dl>
            <dt>Opened</dt>
            <dd>{c.openedAt.slice(0, 16).replace('T', ' ')}</dd>
            <dt>Assigned to</dt>
            <dd>{c.assignedTo ?? <span className="muted">nobody</span>}</dd>
            {c.decidedAt ? (
              <>
                <dt>Decided</dt>
                <dd>
                  {c.decidedAt.slice(0, 16).replace('T', ' ')} by {c.decidedBy ?? '—'}
                </dd>
                <dt>Note</dt>
                <dd>{c.note ?? '—'}</dd>
              </>
            ) : null}
          </dl>
        </div>
        <div className="card">
          <h2>What opened it</h2>
          {/* As the job wrote it; a remitter's text is data, rendered as text. */}
          <dl data-testid="case-payload">
            {Object.entries(c.payload).map(([k, v]) => (
              <Fragment key={k}>
                <dt>{k}</dt>
                <dd>{asText(v)}</dd>
              </Fragment>
            ))}
          </dl>
        </div>
      </div>

      {can.assign ? (
        <form method="post" action={action} className="card">
          <input type="hidden" name="action" value="assign" />
          <button type="submit">Assign to me</button>
        </form>
      ) : null}

      {can.record && prefill ? (
        <form method="post" action={action} className="card" aria-label="Record against an institution">
          <h2>Record against an institution</h2>
          <input type="hidden" name="action" value="record" />
          <input type="hidden" name="key" value={randomUUID()} />
          <dl>
            <dt>Amount</dt>
            <dd>{money$(prefill.amount)}</dd>
            <dt>Rail · reference</dt>
            <dd>
              {prefill.rail} · {prefill.bankReference}
            </dd>
            <dt>Value date</dt>
            <dd>{prefill.valueDate}</dd>
            {prefill.remitterReference ? (
              <>
                <dt>The remitter wrote</dt>
                <dd>
                  <q>{prefill.remitterReference}</q>
                </dd>
              </>
            ) : null}
          </dl>
          <p>
            <label>
              Institution
              <br />
              <select name="institutionId" defaultValue={prefill.institutionId ?? ''} required>
                <option value="" disabled>
                  Choose the institution the money belongs to
                </option>
                {institutions.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name} ({i.market})
                  </option>
                ))}
              </select>
            </label>
          </p>
          <p>
            <label>
              Note (optional)
              <br />
              <input name="note" maxLength={NOTE_MAX} placeholder="How you know whose it is" />
            </label>
          </p>
          <p>
            <button type="submit" className="primary">
              Record deposit
            </button>{' '}
            <span className="muted">Nothing moves until a different finance member approves it; then this case resolves.</span>
          </p>
        </form>
      ) : null}

      {can.resolve || can.dismiss ? (
        <form method="post" action={action} className="card" aria-label="Decide">
          <h2>Decide</h2>
          <input type="hidden" name="action" value="decide" />
          <label>
            Note
            <br />
            <input name="note" maxLength={NOTE_MAX} required placeholder={c.kind === 'suspense' ? 'e.g. Returned to the sender on 2 Nov' : 'What you found and did'} />
          </label>{' '}
          {can.resolve ? (
            <button type="submit" name="decision" value="resolved" className="primary">
              Resolve
            </button>
          ) : null}{' '}
          <button type="submit" name="decision" value="dismissed">
            Dismiss
          </button>
        </form>
      ) : c.status === 'open' || c.status === 'investigating' ? (
        <p className="muted">Only Kesher ops or finance work cases.</p>
      ) : null}
    </>
  );
}
