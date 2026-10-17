import { getAdminData } from '../../../../src/data/memory.ts';
import { problem } from '../../../../src/ui/actor.ts';
import { adminAction, field } from '../../../../src/ui/handler.ts';

const DECISIONS = new Set(['cleared', 'escalated', 'in_review']);

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const form = await request.formData();
  const decision = field(form, 'decision');
  const note = field(form, 'note');
  if (!decision || !DECISIONS.has(decision) || !note) return problem(400, 'VALIDATION_FAILED', 'A decision and a note are required');
  return adminAction('/compliance', (by, now) => getAdminData().decideAlert(id, decision as 'cleared' | 'escalated' | 'in_review', by, note, now));
}
