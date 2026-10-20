// A09 institutions (T-0615, REQ-INS-007): every onboarded institution, its market and active staff.
// The detail page carries the balances, the payment reference and the deposits.
import { getAdminData } from '../../src/data/index.ts';

export default async function InstitutionsPage() {
  const rows = await (await getAdminData()).listInstitutions();
  return (
    <>
      <h1>Institutions</h1>
      <p className="muted">Kesher finance records each bank transfer in from the statement; a second finance member approves it before it posts.</p>
      {rows.length === 0 ? (
        <p className="muted">No institutions yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Market</th>
              <th>Active staff</th>
              <th>Onboarded</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((i) => (
              <tr key={i.id}>
                {/* Institution names are staff text: shown as text. */}
                <td>
                  <a href={`/institutions/${encodeURIComponent(i.id)}`}>{i.name}</a>
                </td>
                <td>{i.market}</td>
                <td>{i.activeStaff}</td>
                <td>{i.createdAt.slice(0, 10)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
