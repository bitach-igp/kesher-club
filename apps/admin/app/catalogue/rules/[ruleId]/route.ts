// Approve (it becomes active) or reject (with a reason) a price rule (T-0929). A different finance member only;
// the API holds the rule, and a refusal comes back on the redirect as a code the page puts in words.
import { getAdminData } from '../../../../src/data/index.ts';
import { AdminDataError } from '../../../../src/data/types.ts';
import { currentActor } from '../../../../src/ui/actor.ts';
import { field } from '../../../../src/ui/handler.ts';

export async function POST(request: Request, ctx: { params: Promise<{ ruleId: string }> }): Promise<Response> {
  const { ruleId } = await ctx.params;
  const to = (query: string) => new Response(null, { status: 303, headers: { location: `/catalogue?${query}` } });
  const form = await request.formData();
  const decision = field(form, 'decision');
  if (decision !== 'approve' && decision !== 'reject') return to('error=INVALID');
  const reason = field(form, 'reason');
  if (decision === 'reject' && !reason) return to('error=INVALID');
  try {
    await (await getAdminData()).decidePriceRule(ruleId, decision, await currentActor(), reason, new Date());
  } catch (e) {
    if (e instanceof AdminDataError) return to(`error=${e.code}`);
    throw e;
  }
  return to(`done=${decision}`);
}
