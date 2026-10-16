// Home: the queues at a glance.
import { queue } from '../src/compliance/alerts.ts';
import { complaintSla } from '../src/compliance/sla.ts';
import { getAdminData } from '../src/data/memory.ts';
import { providerRows } from '../src/providers/bindings.ts';

export default async function HomePage() {
  const data = getAdminData();
  const now = new Date();
  const [alerts, complaints, bindings, flags] = await Promise.all([data.listAlerts(), data.listComplaints(), data.listBindings(), data.listFlags()]);
  const open = complaints.filter((c) => c.status === 'open' || c.status === 'acknowledged').map((c) => complaintSla(c, now));
  const rows = providerRows(bindings, flags);
  return (
    <>
      <h1>Today</h1>
      <div className="grid">
        <div className="card">
          <h2>Compliance alerts</h2>
          <p>
            <strong>{queue(alerts).length}</strong> waiting · <a href="/compliance">open the queue</a>
          </p>
        </div>
        <div className="card">
          <h2>Complaints</h2>
          <p>
            <strong>{open.length}</strong> open · <span className="tag red">{open.filter((s) => s.resolveColour === 'red' || s.resolveColour === 'breached').length} red</span> · <a href="/compliance/complaints">SLA board</a>
          </p>
        </div>
        <div className="card">
          <h2>Providers</h2>
          <p>
            <strong>{rows.filter((r) => r.status === 'live').length}</strong> live · {rows.filter((r) => r.status === 'degraded').length} degraded · {flags.filter((f) => f.pendingFlip).length} flips awaiting a second approval · <a href="/providers">providers and flags</a>
          </p>
        </div>
      </div>
    </>
  );
}
