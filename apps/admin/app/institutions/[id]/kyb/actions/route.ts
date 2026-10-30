// The KYB page's actions (T-0926): dispose of a hit, decide, or give a high-risk approval its second approval.
// Compliance only; the API holds every rule, and a refusal comes back on the redirect as a code the page puts
// in words. The decide form is checked here first, and its key makes a double submit decide once. It lives
// under /actions because Next.js serves a page or a route handler at one path, not both.
import { getAdminData } from '../../../../../src/data/index.ts';
import { AdminDataError } from '../../../../../src/data/types.ts';
import { parseDecisionForm } from '../../../../../src/institutions/kyb.ts';
import { currentActor } from '../../../../../src/ui/actor.ts';
import { field } from '../../../../../src/ui/handler.ts';

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const back = `/institutions/${encodeURIComponent(id)}/kyb`;
  const to = (query: string) => new Response(null, { status: 303, headers: { location: `${back}?${query}` } });
  const by = await currentActor();
  const form = await request.formData();
  const now = new Date();
  const data = await getAdminData();
  try {
    switch (field(form, 'action')) {
      case 'dispose': {
        const outcome = field(form, 'outcome');
        const note = field(form, 'note') ?? '';
        if ((outcome !== 'false_positive' && outcome !== 'true_match') || !note.trim()) return to('error=INVALID');
        await data.disposeKybCheck(field(form, 'checkId') ?? '', outcome, note.trim().slice(0, 1000), by, now);
        return to('done=disposed');
      }
      case 'decide': {
        const parsed = parseDecisionForm({ status: field(form, 'status'), risk: field(form, 'risk'), reasons: field(form, 'reasons'), key: field(form, 'key') });
        if (!parsed.ok) return to(`problem=${parsed.problems.join(',')}`);
        return to(`done=${await data.decideKyb(id, parsed.input, by, now)}`);
      }
      case 'approve':
        await data.approveKybDecision(field(form, 'approvalId') ?? '', by, now);
        return to('done=approved');
      default:
        return to('error=NOT_FOUND');
    }
  } catch (e) {
    if (e instanceof AdminDataError) return to(`error=${e.code}`);
    throw e;
  }
}
