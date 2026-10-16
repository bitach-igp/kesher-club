// TST-ADM-002: flipping a money flag or provider binding needs two distinct admins. Given one
// approval, the flag is unchanged.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@kesher/domain';
import { ApprovalService } from '../approvals/service.ts';
import { AuditService } from '../audit/service.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { FlagService, isMoneyFlag } from './service.ts';

let db: TestDatabase;
let flags: FlagService;
let audit: AuditService;
const admin1 = { partyId: uuidv7(), role: 'admin' };
const admin2 = { partyId: uuidv7(), role: 'admin' };
const now = new Date('2026-11-01T10:00:00Z');

beforeAll(async () => {
  db = await createTestDatabase();
  audit = new AuditService(db);
  flags = new FlagService(db, new ApprovalService(db), audit);
}, 60_000);
afterAll(async () => db.close());

describe('FlagService (REQ-ADM-002)', () => {
  it('reads registry defaults and treats unknown flags as off', async () => {
    expect(await flags.isOn('auth.passkey.primary')).toBe(true);
    expect(await flags.isOn('wallet.enabled')).toBe(false);
    expect(await flags.isOn('made.up')).toBe(false);
    expect(isMoneyFlag('wallet.enabled')).toBe(true);
    expect(isMoneyFlag('ui.hebrew')).toBe(false);
    expect((await flags.list()).find((f) => f.key === 'wallet.enabled')).toMatchObject({ value: false, default: false, owner: 'Ezra', money: true });
  });

  it('one admin proposing wallet.enabled leaves it off; a second distinct admin flips it, with an audit entry', async () => {
    const req = await flags.propose('wallet.enabled', true, admin1, 'pilot go-live', now);
    expect(req.status).toBe('awaiting_second_approval');
    expect(await flags.isOn('wallet.enabled')).toBe(false);
    await expect(flags.approve(req.id, admin1, now)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(await flags.isOn('wallet.enabled')).toBe(false);
    const done = await flags.approve(req.id, admin2, now);
    expect(done.status).toBe('approved');
    expect(await flags.isOn('wallet.enabled')).toBe(true);
    const entries = await audit.list('wallet.enabled');
    expect(entries[0]).toMatchObject({ action: 'flag.flip', actorId: admin2.partyId, reason: 'pilot go-live' });
    expect(await audit.verify()).toMatchObject({ ok: true });
    const state = await db.query<{ approval_id: string; audit_id: string }>(`select approval_id, audit_id from ops.flag_state where key = 'wallet.enabled'`);
    expect(state.rows[0]).toEqual({ approval_id: req.id, audit_id: entries[0]!.id });
  });

  it('non-admins cannot propose, unknown flags are refused, and a no-op flip is refused', async () => {
    await expect(flags.propose('ui.hebrew', false, { partyId: uuidv7(), role: 'finance' }, 'x', now)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(flags.propose('not.a.flag', true, admin1, 'x', now)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(flags.propose('wallet.enabled', true, admin1, 'again', now)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('flag state cannot be written directly without an approval and an audit entry (FK)', async () => {
    await expect(db.query(`insert into ops.flag_state (key, value, changed_at, approval_id, audit_id) values ('p2p.enabled', true, now(), $1, $2)`, [uuidv7(), uuidv7()])).rejects.toMatchObject({ code: '23503' });
  });
});
