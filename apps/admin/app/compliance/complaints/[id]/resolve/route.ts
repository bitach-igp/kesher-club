import { getAdminData } from '../../../../../src/data/memory.ts';
import { adminAction } from '../../../../../src/ui/handler.ts';

export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  return adminAction('/compliance/complaints', (by, now) => getAdminData().resolveComplaint(id, by, now));
}
