// The three load case openers share one reopen statement (T-0765, TST-WAL-003). For each kind: opening twice leaves one row; a resolved
// or dismissed case reopens with the earlier decision kept under `payload.reopened`; an `investigating` one is left alone; the payload
// holds ids and amounts only. Driven directly over PGlite; the end-to-end paths stay in loads.test.ts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { money, uuidv7 } from '@kesher/domain';
import type { Transfer } from '../transfers/service.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { creditCase, creditCaseKey, openCreditCase, openReturnedCase, openUnknownLoadCase, reopenableCase, returnedCaseKey, unknownLoadKey, unknownLoadOpen } from './load-cases.ts';

let db: TestDatabase;
const NOW = new Date('2026-11-02T09:00:00Z');
const LATER = new Date('2026-11-03T09:00:00Z');

beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.close();
});

const transferOf = (): Transfer => ({ id: uuidv7(NOW), amount: money(10000n, 'USD'), toPartyId: uuidv7(NOW), state: 'pending_hold' }) as unknown as Transfer;

interface Kind {
  name: string;
  kind: string;
  key: (id: string) => string;
  open: (t: Transfer, now: Date) => Promise<boolean | void>;
}
const KINDS: Kind[] = [
  { name: 'load_credit_refused', kind: 'load_credit_refused', key: creditCaseKey, open: (t, now) => openCreditCase(db, t, 'ld_1', 'NO_ACCOUNT', 1, now) },
  { name: 'load_returned_after_release', kind: 'load_returned_after_release', key: returnedCaseKey, open: (t, now) => openReturnedCase(db, t, 'ld_1', 'RETURNED', 'after_release', now) },
  { name: 'load_unknown', kind: 'load_unknown', key: unknownLoadKey, open: (t, now) => openUnknownLoadCase(db, t, 'ld_1', now) },
];

const rowOf = async (key: string) => (await db.query<{ kind: string; severity: string; status: string; payload: Record<string, unknown> }>(`select kind, severity, status, payload from ops.case where dedupe_key = $1`, [key])).rows;

describe.each(KINDS)('$name case (T-0765, TST-WAL-003)', (k) => {
  it('opens once: a second open leaves one row', async () => {
    const t = transferOf();
    await k.open(t, NOW);
    await k.open(t, LATER);
    const rows = await rowOf(k.key(t.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe(k.kind);
    expect(rows[0]!.severity).toBe('high');
    expect(rows[0]!.status).toBe('open');
  });

  it.each(['resolved', 'dismissed'])('reopens a %s case and keeps the earlier decision under payload.reopened', async (status) => {
    const t = transferOf();
    await k.open(t, NOW);
    await db.query(`update ops.case set status = $2, resolution = 'paid by hand', resolved_at = $3 where dedupe_key = $1`, [k.key(t.id), status, NOW]);
    await k.open(t, LATER);
    const [row] = await rowOf(k.key(t.id));
    expect(row!.status).toBe('open');
    const reopened = row!.payload.reopened as { at: string; was: string; resolution: string };
    expect(reopened.was).toBe(status);
    expect(reopened.resolution).toBe('paid by hand');
    expect(new Date(reopened.at).toISOString()).toBe(LATER.toISOString());
    const cleared = (await db.query<{ resolved_at: Date | null; resolution: string | null }>(`select resolved_at, resolution from ops.case where dedupe_key = $1`, [k.key(t.id)])).rows[0]!;
    expect(cleared).toEqual({ resolved_at: null, resolution: null });
  });

  it('leaves an investigating case alone', async () => {
    const t = transferOf();
    await k.open(t, NOW);
    await db.query(`update ops.case set status = 'investigating' where dedupe_key = $1`, [k.key(t.id)]);
    await k.open(t, LATER);
    const [row] = await rowOf(k.key(t.id));
    expect(row!.status).toBe('investigating');
    expect(row!.payload.reopened).toBeUndefined();
  });

  it('carries ids and amounts only: no @, no phone digits', async () => {
    const t = transferOf();
    await k.open(t, NOW);
    const text = JSON.stringify((await rowOf(k.key(t.id)))[0]!.payload);
    expect(text).not.toContain('@');
    expect(text).not.toMatch(/\+?\d{10,}/);
    expect(text).toContain(t.id);
    expect(text).toContain('10000');
  });
});

describe('the shared reopen helper and the readers (T-0765)', () => {
  it('reopenableCase answers true for an insert and a reopen, false when left alone', async () => {
    const key = `load-test:${uuidv7(NOW)}`;
    const args = { kind: 'load_unknown', dedupeKey: key, severity: 'high' as const, payload: { transferId: 'x' }, now: NOW };
    expect(await reopenableCase(db, args)).toBe(true);
    expect(await reopenableCase(db, args)).toBe(false);
    await db.query(`update ops.case set status = 'resolved' where dedupe_key = $1`, [key]);
    expect(await reopenableCase(db, { ...args, now: LATER })).toBe(true);
  });

  it('openCreditCase answers true when it opened or reopened (the service counts the refusal on it)', async () => {
    const t = transferOf();
    expect(await openCreditCase(db, t, 'ld_1', 'REFUSED', 1, NOW)).toBe(true);
    expect(await openCreditCase(db, t, 'ld_1', 'REFUSED', 2, LATER)).toBe(false);
  });

  it('creditCase reads open and attempt; unknownLoadOpen is true only while open or investigating', async () => {
    const t = transferOf();
    expect(await creditCase(db, t.id)).toEqual({ open: false, attempt: 0 });
    await openCreditCase(db, t, 'ld_1', 'REFUSED', 3, NOW);
    expect(await creditCase(db, t.id)).toEqual({ open: true, attempt: 3 });
    expect(await unknownLoadOpen(db, t.id)).toBe(false);
    await openUnknownLoadCase(db, t, 'ld_1', NOW);
    expect(await unknownLoadOpen(db, t.id)).toBe(true);
    await db.query(`update ops.case set status = 'dismissed' where dedupe_key = $1`, [unknownLoadKey(t.id)]);
    expect(await unknownLoadOpen(db, t.id)).toBe(false);
  });
});
