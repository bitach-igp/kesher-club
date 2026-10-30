// A12 Ops queue (T-0931, REQ-ADM-005): every ops case that is not a compliance alert, grouped by kind in plain
// words, filtered by kind, status and "assigned to me". Each case opens on its own page to be worked.
import { getAdminData } from '../../src/data/index.ts';
import { filterFrom, groupByKind, KIND_WORDS, KINDS, STATUS_WORDS, STATUSES } from '../../src/ops/view.ts';
import { currentActor } from '../../src/ui/actor.ts';

export default async function OpsQueuePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const one = (k: string) => (typeof sp[k] === 'string' ? sp[k] : undefined);
  const filter = filterFrom({ kind: one('kind'), status: one('status'), mine: one('mine') });
  const actor = await currentActor();
  const groups = groupByKind(await (await getAdminData()).listOpsCases(filter, actor));
  return (
    <>
      <h1>Ops queue</h1>
      <form method="get" action="/ops" className="card" aria-label="Filter the queue">
        <label>
          Kind{' '}
          <select name="kind" defaultValue={filter.kind ?? ''}>
            <option value="">Every kind</option>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_WORDS[k].label}
              </option>
            ))}
          </select>
        </label>{' '}
        <label>
          Status{' '}
          <select name="status" defaultValue={filter.status ?? ''}>
            <option value="">Every status</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_WORDS[s]}
              </option>
            ))}
          </select>
        </label>{' '}
        <label>
          <input type="checkbox" name="mine" value="1" defaultChecked={filter.mine === true} /> Assigned to me
        </label>{' '}
        <button type="submit">Filter</button>
      </form>
      {groups.length === 0 ? <p className="muted">No cases match.</p> : null}
      {groups.map((g) => (
        <section key={g.kind} aria-label={KIND_WORDS[g.kind].label}>
          <h2>
            {KIND_WORDS[g.kind].label} · {g.cases.length}
          </h2>
          <p className="muted">{KIND_WORDS[g.kind].hint}</p>
          <table>
            <thead>
              <tr>
                <th>Severity</th>
                <th>Summary</th>
                <th>Status</th>
                <th>Assigned to</th>
                <th>Opened</th>
              </tr>
            </thead>
            <tbody>
              {g.cases.map((c) => (
                <tr key={c.id}>
                  <td>
                    <span className={`tag ${c.severity}`}>{c.severity}</span>
                  </td>
                  {/* Built from the payload, which may quote a remitter: rendered as text. */}
                  <td>
                    <a href={`/ops/${encodeURIComponent(c.id)}`}>{c.summary}</a>
                  </td>
                  <td>{STATUS_WORDS[c.status]}</td>
                  <td>{c.assignedTo ?? <span className="muted">nobody</span>}</td>
                  <td>{c.openedAt.slice(0, 16).replace('T', ' ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </>
  );
}
