// TST-LED-004: nightly reconciliation matches every partner transaction to a journal by external
// ref and opens a case for any break before 06:00 IL. Given a 1-cent difference, an ops case with
// both amounts exists.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { money, uuidv7 } from '@kesher/domain';
import { AccountService } from '@kesher/api/ledger/accounts';
import { PostgresLedger } from '@kesher/api/ledger/post';
import { createTestDatabase, type TestDatabase } from '@kesher/api/test-db';
import { deadlineFor, ReconJob, type PartnerTransaction } from './recon.ts';

let db: TestDatabase;
let ledger: PostgresLedger;
let accounts: AccountService;
let partner: string;
let wallet: string;

beforeAll(async () => {
  db = await createTestDatabase();
  ledger = new PostgresLedger(db);
  accounts = new AccountService(db, ledger);
  partner = await accounts.systemAccount('partner_settlement', 'USD');
  const party = uuidv7();
  await accounts.provisionMember(party);
  wallet = await accounts.memberAccount(party, 'wallet', 'USD');
}, 60_000);
afterAll(async () => db.close());

async function postWithRef(externalId: string, minor: bigint) {
  const j = await ledger.post({ idempotencyKey: `processor:${externalId}`, kind: 'load', postings: [{ accountId: partner, currency: 'USD', amountMinor: minor }, { accountId: wallet, currency: 'USD', amountMinor: -minor }] });
  await db.query(`insert into ops.external_ref (entity_type, entity_id, provider, external_id) values ('journal', $1, 'processor', $2)`, [j.id, externalId]);
  return j;
}

const source = (txns: PartnerTransaction[]) => ({ fetch: async () => txns });
const at = (iso: string) => () => new Date(iso);

describe('ReconJob (REQ-LED-004)', () => {
  it('matches journals to partner records by external ref with zero breaks', async () => {
    await postWithRef('ptx-1', 1_000n);
    await postWithRef('ptx-2', 2_000n);
    const job = new ReconJob(db, source([{ provider: 'processor', externalId: 'ptx-1', amount: money(1_000n, 'USD') }, { provider: 'processor', externalId: 'ptx-2', amount: money(2_000n, 'USD') }]), at('2026-11-02T02:30:00Z'));
    const report = await job.run('processor', '2026-11-02');
    expect(report.matched).toBe(2);
    expect(report.breaks).toEqual([]);
    expect(report.withinDeadline).toBe(true);
  });

  it('a 1-cent difference opens a case holding both amounts, before 06:00 IL (TST-LED-004)', async () => {
    await postWithRef('ptx-3', 5_000n);
    const job = new ReconJob(db, source([{ provider: 'processor', externalId: 'ptx-1', amount: money(1_000n, 'USD') }, { provider: 'processor', externalId: 'ptx-2', amount: money(2_000n, 'USD') }, { provider: 'processor', externalId: 'ptx-3', amount: money(5_001n, 'USD') }]), at('2026-11-03T03:10:00Z'));
    const report = await job.run('processor', '2026-11-03');
    expect(report.breaks).toEqual([expect.objectContaining({ externalId: 'ptx-3', reason: 'amount_mismatch', partner: money(5_001n, 'USD'), ledger: money(5_000n, 'USD') })]);
    const c = await db.query<{ payload: Record<string, string>; severity: string; opened_at: string | Date }>(`select payload, severity, opened_at from ops.case where kind = 'recon_break' and payload->>'externalId' = 'ptx-3'`);
    expect(c.rows.length).toBe(1);
    expect(c.rows[0]!.payload).toMatchObject({ partnerMinor: '5001', ledgerMinor: '5000', reason: 'amount_mismatch' });
    expect(c.rows[0]!.severity).toBe('high');
    expect(new Date(c.rows[0]!.opened_at).getTime()).toBeLessThanOrEqual(deadlineFor('2026-11-03').getTime());
    expect((await db.query(`select reason from ops.recon_break where external_id = 'ptx-3'`)).rows).toEqual([{ reason: 'amount_mismatch' }]);
  });

  it('reports partner records we never journaled and journals the partner never saw', async () => {
    await postWithRef('ptx-4', 10n);
    const job = new ReconJob(db, source([{ provider: 'processor', externalId: 'ptx-1', amount: money(1_000n, 'USD') }, { provider: 'processor', externalId: 'ptx-2', amount: money(2_000n, 'USD') }, { provider: 'processor', externalId: 'ptx-3', amount: money(5_000n, 'USD') }, { provider: 'processor', externalId: 'ghost-9', amount: money(77n, 'USD') }]), at('2026-11-04T02:00:00Z'));
    const report = await job.run('processor', '2026-11-04');
    expect(report.breaks.map((b) => [b.externalId, b.reason])).toEqual(expect.arrayContaining([['ghost-9', 'missing_journal'], ['ptx-4', 'missing_partner']]));
    expect(report.breaks.length).toBe(2);
  });

  it('re-running the same night does not duplicate cases; a new night does', async () => {
    const txns = [{ provider: 'processor', externalId: 'ghost-9', amount: money(77n, 'USD') }];
    await new ReconJob(db, source(txns), at('2026-11-05T02:00:00Z')).run('processor', '2026-11-05');
    await new ReconJob(db, source(txns), at('2026-11-05T02:30:00Z')).run('processor', '2026-11-05');
    const n = async (d: string) => (await db.query<{ n: number }>(`select count(*)::int as n from ops.case where dedupe_key = $1`, [`recon:processor:ghost-9:${d}`])).rows[0]!.n;
    expect(await n('2026-11-05')).toBe(1);
    await new ReconJob(db, source(txns), at('2026-11-06T02:00:00Z')).run('processor', '2026-11-06');
    expect(await n('2026-11-06')).toBe(1);
  });

  it('flags a run that finishes after 06:00 Israel time', async () => {
    const report = await new ReconJob(db, source([]), at('2026-11-07T04:30:00Z')).run('processor', '2026-11-07'); // 06:30 IST
    expect(report.withinDeadline).toBe(false);
    expect(deadlineFor('2026-11-07').toISOString()).toBe('2026-11-07T04:00:00.000Z'); // winter: UTC+2
    expect(deadlineFor('2026-07-07').toISOString()).toBe('2026-07-07T03:00:00.000Z'); // summer: UTC+3
  });
});
