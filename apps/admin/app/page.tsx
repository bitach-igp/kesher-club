// Home: the queues at a glance.
import { queue } from '../src/compliance/alerts.ts';
import { complaintSla } from '../src/compliance/sla.ts';
import { getAdminData } from '../src/data/index.ts';
import { providerRows } from '../src/providers/bindings.ts';

export default async function HomePage() {
  const data = await getAdminData();
  const now = new Date();
  const [alerts, complaints, bindings, flags] = await Promise.all([data.listAlerts(), data.listComplaints(), data.listBindings(), data.listFlags()]);
  const open = complaints.filter((c) => c.status === 'open' || c.status === 'acknowledged').map((c) => complaintSla(c, now));
  const rows = providerRows(bindings, flags);
  return (
    <>
      <h1>Today</h1>
      <div className="stats">
        <div className="stat">
          <h2>Compliance alerts</h2>
          <div className="value">{queue(alerts).length}</div>
          <p className="muted">
            waiting · <a href="/compliance">open the queue</a>
          </p>
        </div>
        <div className="stat">
          <h2>Complaints</h2>
          <div className="value">{open.length}</div>
          <p className="muted">
            open · <span className="tag red">{open.filter((s) => s.resolveColour === 'red' || s.resolveColour === 'breached').length} red</span> · <a href="/compliance/complaints">SLA board</a>
          </p>
        </div>
        <div className="stat">
          <h2>Providers</h2>
          <div className="value">{rows.filter((r) => r.status === 'live').length}</div>
          <p className="muted">
            live · {rows.filter((r) => r.status === 'degraded').length} degraded · {flags.filter((f) => f.pendingFlip).length} flips awaiting a second approval · <a href="/providers">providers and flags</a>
          </p>
        </div>
      </div>
    </>
  );
}
