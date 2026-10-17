import { getAdminData } from '../../../../src/data/memory.ts';
import { adminAction } from '../../../../src/ui/handler.ts';

export async function POST(_request: Request, ctx: { params: Promise<{ key: string }> }): Promise<Response> {
  const { key } = await ctx.params;
  return adminAction(`/providers/${encodeURIComponent(key)}`, (by, now) => getAdminData().killSwitch(key, by, now));
}
