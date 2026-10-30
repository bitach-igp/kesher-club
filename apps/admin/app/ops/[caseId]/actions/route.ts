// Work an ops case (T-0931): take it, decide it with a note, or record its suspense credit as a deposit against
// the institution finance chose. The deposit's fields come from the case, never the form, so nothing is retyped;
// the form's key makes a double submit record once. Refusals come back on the redirect, and the page words them.
import { getAdminData } from '../../../../src/data/index.ts';
import { AdminDataError } from '../../../../src/data/types.ts';
import { depositPrefill, parseNote } from '../../../../src/ops/view.ts';
import { currentActor } from '../../../../src/ui/actor.ts';
import { field } from '../../../../src/ui/handler.ts';

export async function POST(request: Request, ctx: { params: Promise<{ caseId: string }> }): Promise<Response> {
  const { caseId } = await ctx.params;
  const back = `/ops/${encodeURIComponent(caseId)}`;
  const to = (query: string) => new Response(null, { status: 303, headers: { location: `${back}?${query}` } });
  const by = await currentActor();
  const form = await request.formData();
  const now = new Date();
  const data = await getAdminData();
  try {
    switch (field(form, 'action')) {
      case 'assign':
        await data.assignOpsCase(caseId, by, now);
        return to('done=assign');
      case 'decide': {
        const decision = field(form, 'decision');
        if (decision !== 'resolved' && decision !== 'dismissed') return to('error=INVALID');
        const note = parseNote(field(form, 'note'));
        if (!note.ok) return to(`error=${note.problem}`);
        await data.decideOpsCase(caseId, decision, note.note, by, now);
        return to(`done=${decision}`);
      }
      case 'record': {
        const c = await data.getOpsCase(caseId);
        const prefill = c ? depositPrefill(c) : undefined;
        if (!prefill) return to('error=INVALID');
        const institutionId = field(form, 'institutionId');
        if (!institutionId) return to('error=institution');
        const key = field(form, 'key');
        if (!key) return to('error=INVALID');
        const note = field(form, 'note');
        await data.recordDeposit(institutionId, { amount: prefill.amount, rail: prefill.rail, bankReference: prefill.bankReference, valueDate: prefill.valueDate, ...(note ? { note: note.slice(0, 500) } : {}), key, caseId }, by, now);
        return to('done=recorded');
      }
      default:
        return to('error=INVALID');
    }
  } catch (e) {
    if (e instanceof AdminDataError) return to(`error=${e.code}`);
    throw e;
  }
}
