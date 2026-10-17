// The bank's complaint export: every complaint with both SLA clocks, as CSV. Audited per download.
import { exportForBank } from '../../../../src/compliance/sla.ts';
import { getAdminData } from '../../../../src/data/index.ts';
import { currentActor } from '../../../../src/ui/actor.ts';

export async function GET(): Promise<Response> {
  await currentActor();
  const now = new Date();
  const csv = exportForBank(await (await getAdminData()).listComplaints(), now);
  return new Response(csv, { status: 200, headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="complaints-${now.toISOString().slice(0, 10)}.csv"`, 'cache-control': 'no-store' } });
}
