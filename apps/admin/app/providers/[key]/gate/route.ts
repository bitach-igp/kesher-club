import { getAdminData } from '../../../../src/data/index.ts';
import { adminAction, field } from '../../../../src/ui/handler.ts';

export async function POST(request: Request, ctx: { params: Promise<{ key: string }> }): Promise<Response> {
  const { key } = await ctx.params;
  const form = await request.formData();
  const gate = field(form, 'gate') ?? '';
  const ticked = field(form, 'ticked') === 'true';
  return adminAction(`/providers/${encodeURIComponent(key)}`, async (by, now) => (await getAdminData()).tickGate(key, gate, ticked, by, now));
}
