import { AdminDataError } from '../../../../src/data/types.ts';
import { getAdminData } from '../../../../src/data/index.ts';
import { adminAction, field } from '../../../../src/ui/handler.ts';

export async function POST(request: Request, ctx: { params: Promise<{ key: string }> }): Promise<Response> {
  const { key } = await ctx.params;
  const form = await request.formData();
  const action = field(form, 'action');
  const to = field(form, 'to') === 'true';
  const back = `/providers/${encodeURIComponent(key)}`;
  try {
    return await adminAction(back, async (by, now) => (action === 'approve' ? (await getAdminData()).approveFlip(key, by, now) : (await getAdminData()).proposeFlip(key, to, by, now)));
  } catch (e) {
    if (e instanceof AdminDataError) return new Response(null, { status: 303, headers: { location: `${back}?error=${encodeURIComponent(e.message)}` } });
    throw e;
  }
}
