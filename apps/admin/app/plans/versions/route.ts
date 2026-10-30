// Propose a plan version (T-0933): the form is checked here first; a refusal comes back on the redirect as a code
// or a field list, and the page puts it in words.
import { getAdminData } from '../../../src/data/index.ts';
import { AdminDataError } from '../../../src/data/types.ts';
import { parsePlanForm } from '../../../src/plans/view.ts';
import { currentActor } from '../../../src/ui/actor.ts';
import { field } from '../../../src/ui/handler.ts';

export async function POST(request: Request): Promise<Response> {
  const to = (query: string) => new Response(null, { status: 303, headers: { location: `/plans?${query}` } });
  const by = await currentActor();
  const form = await request.formData();
  const f = (name: string) => field(form, name);
  const parsed = parsePlanForm({ planCode: f('planCode'), name: f('name'), market: f('market'), price: f('price'), termMonths: f('termMonths'), dataGb: f('dataGb'), conciergeCalls: f('conciergeCalls'), fxMarkup: f('fxMarkup'), effectiveFrom: f('effectiveFrom'), reason: f('reason') });
  if (!parsed.ok) return to(`problem=${parsed.problems.join(',')}`);
  try {
    await (await getAdminData()).proposePlanVersion(parsed.input, by, new Date());
  } catch (e) {
    if (e instanceof AdminDataError) return to(`error=${e.code}`);
    throw e;
  }
  return to('done=proposed');
}
