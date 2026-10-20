// Record a deposit (T-0615): the form is checked here first; a refusal comes back on the redirect as a code
// or a field list, and the page puts it in words. The form's key makes a double submit record once.
import { getAdminData } from '../../../../src/data/index.ts';
import { AdminDataError } from '../../../../src/data/types.ts';
import { parseDepositForm } from '../../../../src/institutions/view.ts';
import { currentActor } from '../../../../src/ui/actor.ts';
import { field } from '../../../../src/ui/handler.ts';

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const back = `/institutions/${encodeURIComponent(id)}`;
  const to = (query: string) => new Response(null, { status: 303, headers: { location: `${back}?${query}` } });
  const by = await currentActor();
  const form = await request.formData();
  const now = new Date();
  const parsed = parseDepositForm({ amount: field(form, 'amount'), currency: field(form, 'currency'), rail: field(form, 'rail'), bankReference: field(form, 'bankReference'), valueDate: field(form, 'valueDate'), note: field(form, 'note'), key: field(form, 'key') }, now);
  if (!parsed.ok) return to(`problem=${parsed.problems.join(',')}`);
  try {
    await (await getAdminData()).recordDeposit(id, parsed.input, by, now);
  } catch (e) {
    if (e instanceof AdminDataError) return to(`error=${e.code}`);
    throw e;
  }
  return to('done=recorded');
}
