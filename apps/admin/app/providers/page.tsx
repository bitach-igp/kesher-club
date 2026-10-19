// A07 Providers & Flags (T-0902): every port with its binding in each market (T-0913), the flags that
// gate it (club-wide), release gate progress, pending two-person flips, and the kill switch.
import { getAdminData } from '../../src/data/index.ts';
import { providerRows } from '../../src/providers/bindings.ts';

export default async function ProvidersPage() {
  const data = await getAdminData();
  const rows = providerRows(await data.listBindings(), await data.listFlags());
  return (
    <>
      <h1>Providers and flags</h1>
      <p className="muted">A flag goes to 100% only when every release gate is ticked and two admins approve. The kill switch turns a flag off at once, by one admin, audited.</p>
      <table>
        <thead>
          <tr>
            <th>Port</th>
            <th>Market</th>
            <th>Binding</th>
            <th>Status</th>
            <th>Contract nights</th>
            <th>Flags</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.capability}:${r.market}`}>
              <td>
                <strong>{r.port}</strong>
                <br />
                <span className="muted">
                  {r.capability} · {r.direction} · vendors: {r.vendors.join(', ')}
                </span>
              </td>
              <td>{r.market}</td>
              <td>{r.binding}</td>
              <td>
                <span className={`tag ${r.status}`}>{r.status}</span>
              </td>
              <td>{r.contractGreenNights}/7</td>
              <td>
                {r.flags.map((f) => (
                  <div key={f.key}>
                    <a href={`/providers/${encodeURIComponent(f.key)}`}>{f.key}</a> <span className={`tag ${f.on ? 'green' : ''}`}>{f.on ? 'on' : 'off'}</span>{' '}
                    <span className="muted">
                      gates {f.gatesTicked}/{f.gatesTotal}
                    </span>
                    {f.pending ? <span className="tag amber">awaiting 2nd approval</span> : null}
                  </div>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
