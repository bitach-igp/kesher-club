// Staff as the institution console shows them (T-0609, T-0527): "Finance •••• 0109", the role they hold
// now and the last four digits of their phone. Never a party id or a full phone; "Former staff" once they
// have left. A display label, not an audit record: the approvals and the audit chain are that.
import type { IdentityRepository } from '../auth/repository.ts';
import type { Database } from '../db.ts';

const ROLE_NAME: Record<string, string> = { staff: 'Staff', finance: 'Finance', admin: 'Institution admin' };

export type StaffName = { displayName: string };

export async function staffNames(db: Database, identity: Pick<IdentityRepository, 'findUser'>, partyIds: readonly string[]): Promise<Map<string, StaffName>> {
  const ids = [...new Set(partyIds)];
  if (ids.length === 0) return new Map();
  const roles = new Map((await db.query<{ party_id: string; role: string }>('select party_id, role from org.staff where party_id = any($1::uuid[]) and active', [ids])).rows.map((x) => [x.party_id, x.role]));
  return new Map(
    await Promise.all(
      ids.map(async (id) => {
        const user = await identity.findUser(id);
        const label = ROLE_NAME[roles.get(id) ?? ''] ?? 'Former staff';
        return [id, { displayName: user ? `${label} •••• ${user.phone.slice(-4)}` : label }] as const;
      }),
    ),
  );
}
