// A01 customer search.
import { getAdminData } from '../../src/data/index.ts';

export default async function CustomersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const q = typeof sp['q'] === 'string' ? sp['q'] : '';
  const results = await (await getAdminData()).searchCustomers(q);
  return (
    <>
      <h1>Customer 360</h1>
      <form method="get" className="card">
        <label>
          Name, phone, email or id <input name="q" defaultValue={q} autoComplete="off" />
        </label>{' '}
        <button className="primary" type="submit">
          Search
        </button>
      </form>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Mode</th>
            <th>Locale</th>
            <th>Since</th>
          </tr>
        </thead>
        <tbody>
          {results.map((c) => (
            <tr key={c.partyId}>
              <td>
                <a href={`/customers/${encodeURIComponent(c.partyId)}`}>{c.displayName}</a>
              </td>
              <td>{c.mode}</td>
              <td>{c.locale}</td>
              <td>{c.createdAt.slice(0, 10)}</td>
            </tr>
          ))}
          {results.length === 0 ? (
            <tr>
              <td colSpan={4} className="muted">
                No match.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </>
  );
}
