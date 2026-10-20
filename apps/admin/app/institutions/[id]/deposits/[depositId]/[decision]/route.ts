// Approve (it posts) or reject (with a reason) a deposit (T-0615). The second finance member only; the API
// holds the rule, and a refusal comes back on the redirect as a code the page puts in words.
import { getAdminData } from '../../../../../../src/data/index.ts';
import { AdminDataError } from '../../../../../../src/data/types.ts';
import { currentActor } from '../../../../../../src/ui/actor.ts';
import { field } from '../../../../../../src/ui/handler.ts';

export async function POST(request: Request, ctx: { params: Promise<{ id: string; depositId: string; decision: string }> }): Promise<Response> {
  const { id, depositId, decision } = await ctx.params;
  const back = `/institutions/${encodeURIComponent(id)}`;
  const to = (query: string) => new Response(null, { status: 303, headers: { location: `${back}?${query}` } });
  if (decision !== 'approve' && decision !== 'reject') return to('error=NOT_FOUND');
  const by = await currentActor();
  const reason = field(await request.formData(), 'reason');
  if (decision === 'reject' && !reason) return to('error=INVALID');
  try {
    await (await getAdminData()).decideDeposit(depositId, decision, by, reason, new Date());
  } catch (e) {
    if (e instanceof AdminDataError) return to(`error=${e.code}`);
    throw e;
  }
  return to(`done=${decision}`);
}
