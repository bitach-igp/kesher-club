// Propose a price rule (T-0929): the form is checked here first; a refusal comes back on the redirect as a code
// or a field list, and the page puts it in words.
import { parseRuleForm } from '../../../src/catalogue/view.ts';
import { getAdminData } from '../../../src/data/index.ts';
import { AdminDataError } from '../../../src/data/types.ts';
import { currentActor } from '../../../src/ui/actor.ts';
import { field } from '../../../src/ui/handler.ts';

export async function POST(request: Request): Promise<Response> {
  const to = (query: string) => new Response(null, { status: 303, headers: { location: `/catalogue?${query}` } });
  const by = await currentActor();
  const form = await request.formData();
  const parsed = parseRuleForm({ kind: field(form, 'kind'), provider: field(form, 'provider'), skuPattern: field(form, 'skuPattern'), margin: field(form, 'margin'), floor: field(form, 'floor'), currency: field(form, 'currency'), roundTo99: field(form, 'roundTo99'), priority: field(form, 'priority'), reason: field(form, 'reason') });
  if (!parsed.ok) return to(`problem=${parsed.problems.join(',')}`);
  try {
    await (await getAdminData()).proposePriceRule(parsed.input, by, new Date());
  } catch (e) {
    if (e instanceof AdminDataError) return to(`error=${e.code}`);
    throw e;
  }
  return to('done=proposed');
}
