// A02 Compliance alerts queue (T-0904): severity first, then age; decide with a note.
import { ageHours, ALERT_LABEL, queue } from '../../src/compliance/alerts.ts';
import { getAdminData } from '../../src/data/index.ts';

export default async function CompliancePage() {
  const now = new Date();
  const alerts = queue(await (await getAdminData()).listAlerts());
  return (
    <>
      <h1>Compliance alerts</h1>
      <p>
        <a href="/compliance/complaints">Complaints and SLA board</a>
      </p>
      <table>
        <thead>
          <tr>
            <th>Severity</th>
            <th>Kind</th>
            <th>Summary</th>
            <th>Customer</th>
            <th>Age</th>
            <th>Status</th>
            <th>Decision</th>
          </tr>
        </thead>
        <tbody>
          {alerts.map((a) => (
            <tr key={a.id}>
              <td>
                <span className={`tag ${a.severity}`}>{a.severity}</span>
              </td>
              <td>{ALERT_LABEL[a.kind]}</td>
              {/* Summary may quote member or merchant text: rendered as text. */}
              <td>{a.summary}</td>
              <td>{a.partyId ? <a href={`/customers/${encodeURIComponent(a.partyId)}`}>open 360</a> : '—'}</td>
              <td>{ageHours(a, now)} h</td>
              <td>{a.status}</td>
              <td>
                <form method="post" action={`/compliance/alerts/${encodeURIComponent(a.id)}`} className="inline">
                  <input name="note" placeholder="note" required maxLength={500} />{' '}
                  <button name="decision" value="cleared" type="submit">
                    Clear
                  </button>{' '}
                  <button name="decision" value="in_review" type="submit">
                    Review
                  </button>{' '}
                  <button name="decision" value="escalated" type="submit" className="danger">
                    Escalate
                  </button>
                </form>
              </td>
            </tr>
          ))}
          {alerts.length === 0 ? (
            <tr>
              <td colSpan={7} className="muted">
                Queue empty.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </>
  );
}
