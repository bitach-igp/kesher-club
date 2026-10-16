// TST-ADM-001: every admin action records actor, reason, before/after hash in a hash-chained
// audit log. Given a tampered row, the chain verification job fails.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@kesher/domain';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { AuditService, GENESIS, canonical, hashState } from './service.ts';

let db: TestDatabase;
let audit: AuditService;
const admin = uuidv7();
const now = new Date('2026-11-01T10:00:00Z');

beforeAll(async () => {
  db = await createTestDatabase();
  audit = new AuditService(db);
}, 60_000);
afterAll(async () => db.close());

describe('AuditService (REQ-ADM-001)', () => {
  it('chains entries from genesis and verifies clean', async () => {
    const a = await audit.record({ actorId: admin, actorRole: 'admin', action: 'flag.flip', subject: 'wallet.enabled', reason: 'pilot go-live', before: { value: false }, after: { value: true } }, now);
    const b = await audit.record({ actorId: admin, actorRole: 'admin', action: 'member.freeze', subject: 'party:123', reason: 'fraud alert FRD-9', payload: { caseId: 'c1' } }, new Date(now.getTime() + 1000));
    expect(a.prevHash).toBe(GENESIS);
    expect(b.prevHash).toBe(a.hash);
    expect(a.beforeHash).toBe(hashState({ value: false }));
    expect(await audit.verify()).toEqual({ ok: true, entries: 2 });
    expect(JSON.stringify(await audit.list('wallet.enabled'))).not.toContain('"before"'); // only hashes are stored
  });

  it('a reason is mandatory', async () => {
    await expect(audit.record({ actorId: admin, actorRole: 'admin', action: 'x', subject: 'y', reason: '  ' }, now)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('a tampered row fails verification at that row (TST-ADM-001)', async () => {
    // Tamper as the migrator (the app role cannot UPDATE audit.entry at all).
    await db.query(`update audit.entry set reason = 'routine' where seq = 1`);
    expect(await audit.verify()).toMatchObject({ ok: false, brokenAtSeq: 1, reason: expect.stringContaining('hash') });
    await db.query(`update audit.entry set reason = 'pilot go-live' where seq = 1`);
    expect((await audit.verify()).ok).toBe(true);
  });

  it('a deleted row breaks the link of the next row', async () => {
    const c = await audit.record({ actorId: admin, actorRole: 'admin', action: 'x', subject: 'z', reason: 'r' }, now);
    await db.query(`delete from audit.entry where seq = 2`);
    expect(await audit.verify()).toMatchObject({ ok: false, brokenAtSeq: c.seq, reason: expect.stringContaining('previous row') });
  });

  it('the app role can only append', async () => {
    await db.asRole('club_app', async (app) => {
      await expect(app.query(`update audit.entry set reason = 'x'`)).rejects.toMatchObject({ code: '42501' });
      await expect(app.query(`delete from audit.entry`)).rejects.toMatchObject({ code: '42501' });
    });
  });

  it('canonical JSON is key-order independent and bigint-safe', () => {
    expect(canonical({ b: 1n, a: { d: 2, c: 3 } })).toBe(canonical({ a: { c: 3, d: 2 }, b: 1n }));
    expect(hashState({ x: 1 })).not.toBe(hashState({ x: 2 }));
  });
});
