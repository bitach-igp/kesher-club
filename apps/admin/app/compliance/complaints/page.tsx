// A03 complaints with SLA timers (T-0904, REQ-CMP-002): acknowledge 2 business days, resolve 15.
// Red from day 13. Export for the bank in one click.
import { complaintSla, RESOLVE_BUSINESS_DAYS, sortBySla } from '../../../src/compliance/sla.ts';
import { getAdminData } from '../../../src/data/index.ts';

export default async function ComplaintsPage() {
  const now = new Date();
  const rows = sortBySla((await (await getAdminData()).listComplaints()).map((c) => ({ c, sla: complaintSla(c, now) })));
  return (
    <>
      <h1>Complaints</h1>
      <p>
        Acknowledge within 2 business days, resolve within {RESOLVE_BUSINESS_DAYS}. Rows turn amber at day 10 and red at day 13. <a className="button" href="/compliance/complaints/export">Export for the bank (CSV)</a>
      </p>
      <table>
        <thead>
          <tr>
            <th>SLA</th>
            <th>Opened</th>
            <th>Days open</th>
            <th>Acknowledge</th>
            <th>Resolve by</th>
            <th>Channel · category</th>
            <th>Summary</th>
            <th>Owner</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ c, sla }) => (
            <tr key={c.id}>
              <td>
                <span className={`tag ${sla.resolveColour}`}>{sla.resolveColour}</span>
              </td>
              <td>{c.openedAt.slice(0, 10)}</td>
              <td>{sla.businessDaysOpen}</td>
              <td>{c.acknowledgedAt ? <span className={`tag ${sla.ackMet ? 'green' : 'red'}`}>{sla.ackMet ? 'on time' : 'late'}</span> : <span className={`tag ${sla.ackBreached ? 'red' : 'amber'}`}>due {sla.ackDue.slice(0, 10)}</span>}</td>
              <td>{sla.resolveDue.slice(0, 10)}</td>
              <td>
                {c.channel} · {c.category} {c.escalatedToBank ? <span className="tag amber">bank</span> : null}
              </td>
              {/* Member text: shown as text. */}
              <td>{c.summary}</td>
              <td>{c.owner ?? '—'}</td>
              <td>
                {c.status === 'open' ? (
                  <form method="post" action={`/compliance/complaints/${encodeURIComponent(c.id)}/ack`} className="inline">
                    <button type="submit">Acknowledge</button>
                  </form>
                ) : null}{' '}
                {c.status === 'open' || c.status === 'acknowledged' ? (
                  <form method="post" action={`/compliance/complaints/${encodeURIComponent(c.id)}/resolve`} className="inline">
                    <button type="submit" className="primary">
                      Resolve
                    </button>
                  </form>
                ) : (
                  <span className="muted">{c.status}</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
