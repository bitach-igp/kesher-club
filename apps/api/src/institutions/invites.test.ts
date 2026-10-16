// TST-INS-002: each family on a roster receives an invite, and the console shows the funnel
// invited → verified → active. Given 120 invited, the counts add up to 120.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@kesher/domain';
import { NotifySimulator } from '@kesher/ports';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { InviteService } from './invites.ts';
import { RosterService } from './roster.ts';

let db: TestDatabase;
let roster: RosterService;
let invites: InviteService;
let notify: NotifySimulator;
let institutionId: string;
const now = new Date('2026-11-01T10:00:00Z');
const mapping = { memberName: 'Student', memberPhone: 'Student mobile', funderEmail: 'Parent email', funderPhone: 'Parent mobile' };

function csv(rows: number): string {
  const lines = ['Student,Student mobile,Parent email,Parent mobile'];
  for (let i = 1; i <= rows; i++) lines.push(`Student ${i},+9725${String(i).padStart(8, '0')},parent${i}@example.com,${i % 10 === 0 ? '' : `+1555${String(i).padStart(7, '0')}`}`);
  return lines.join('\n');
}

beforeAll(async () => {
  db = await createTestDatabase();
  roster = new RosterService(db);
  notify = new NotifySimulator();
  invites = new InviteService(db, notify);
  institutionId = uuidv7();
  await db.query(`insert into org.institution (id, name, market) values ($1, 'Yeshivat Example', 'IL')`, [institutionId]);
}, 60_000);
afterAll(async () => db.close());

describe('InviteService (REQ-INS-002)', () => {
  it('fans out one invite per family after a committed import, idempotently, and the funnel sums to the roster size', async () => {
    const imp = await roster.import({ idempotencyKey: 'imp-1', institutionId, csv: csv(120), mapping, commit: true, createdBy: uuidv7() }, now);
    const a = await invites.fanOut(imp.importId, now);
    const b = await invites.fanOut(imp.importId, now);
    expect(a.sent).toBe(120);
    expect(b.sent).toBe(0);
    expect(notify.sent.filter((n) => n.template === 'institution.invite').length).toBe(120);
    const funnel = await invites.funnel(institutionId);
    expect(funnel).toEqual({ invited: 120, verified: 0, active: 0, declined: 0, total: 120 });
    expect(funnel.invited + funnel.verified + funnel.active + funnel.declined).toBe(120);
  });

  it('invites go by email to the funder and carry an opaque token; the address never lands in the row', async () => {
    const [first] = notify.sent;
    expect(first).toMatchObject({ channel: 'email', to: 'parent1@example.com', category: 'service', data: expect.objectContaining({ inviteUrl: expect.stringMatching(/^https:\/\/app\.kesher\.example\/invite\/[A-Za-z0-9_-]{20,}$/) }) });
    const row = await db.query<{ recipient_hash: string; token_hash: string }>('select recipient_hash, token_hash from org.invite limit 1');
    expect(row.rows[0]!.recipient_hash).not.toContain('@');
    expect(JSON.stringify(row.rows)).not.toContain('parent1');
  });

  it('accepting an invite moves the family to verified, activation to active, and the funnel stays a partition', async () => {
    const url = (notify.sent[0]!.data['inviteUrl'] ?? '').split('/').pop()!;
    const accepted = await invites.accept(url, { funderPartyId: uuidv7(), memberPartyId: uuidv7() }, now);
    expect(accepted.status).toBe('verified');
    await expect(invites.accept(url, { funderPartyId: uuidv7(), memberPartyId: uuidv7() }, now)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await invites.activate(accepted.memberId, now);
    const funnel = await invites.funnel(institutionId);
    expect(funnel).toEqual({ invited: 119, verified: 0, active: 1, declined: 0, total: 120 });
  });

  it('expired or unknown tokens are refused and a reminder re-sends to still-invited families only', async () => {
    await expect(invites.accept('nope', { funderPartyId: uuidv7(), memberPartyId: uuidv7() }, now)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const url = (notify.sent[1]!.data['inviteUrl'] ?? '').split('/').pop()!;
    await expect(invites.accept(url, { funderPartyId: uuidv7(), memberPartyId: uuidv7() }, new Date(now.getTime() + 31 * 86_400_000))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const before = notify.sent.length;
    const r = await invites.remind(institutionId, new Date(now.getTime() + 3 * 86_400_000));
    expect(r.sent).toBe(119);
    expect(notify.sent.length - before).toBe(119);
    expect(notify.sent.slice(before).every((n) => n.template === 'institution.invite_reminder')).toBe(true);
  });
});
