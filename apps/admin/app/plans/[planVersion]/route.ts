// Approve (new members join on it from its date) or reject (with a reason) a plan version (T-0933). A different
// finance member only; the API holds the version, and a refusal comes back on the redirect as a code the page words.
import { getAdminData } from '../../../src/data/index.ts';
import { AdminDataError } from '../../../src/data/types.ts';
import { parseVersionKey } from '../../../src/plans/view.ts';
import { currentActor } from '../../../src/ui/actor.ts';
import { field } from '../../../src/ui/handler.ts';

export async function POST(request: Request, ctx: { params: Promise<{ planVersion: string }> }): Promise<Response> {
  const target = parseVersionKey(decodeURIComponent((await ctx.params).planVersion));
  const to = (query: string) => new Response(null, { status: 303, headers: { location: `/plans?${query}` } });
  if (!target) return to('error=NOT_FOUND');
  const form = await request.formData();
  const decision = field(form, 'decision');
  if (decision !== 'approve' && decision !== 'reject') return to('error=INVALID');
  const reason = field(form, 'reason');
  if (decision === 'reject' && !reason) return to('error=INVALID');
  try {
    await (await getAdminData()).decidePlanVersion(target.planCode, target.version, decision, await currentActor(), reason, new Date());
  } catch (e) {
    if (e instanceof AdminDataError) return to(`error=${e.code}`);
    throw e;
  }
  return to(`done=${decision}`);
}
