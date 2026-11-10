// TST-LED-004: nightly reconciliation matches every partner transaction to a journal by external
// ref and opens a case for any break before 06:00 IL. Given a 1-cent difference, an ops case with
// both amounts exists.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { money, uuidv7 } from '@kesher/domain';
import { AccountService } from '@kesher/api/ledger/accounts';
import { PostgresLedger } from '@kesher/api/ledger/post';
import { createTestDatabase, type TestDatabase } from '@kesher/api/test-db';
import { createApp, type App } from '@kesher/api/app';
import { generateSigningKey } from '@kesher/api/auth/tokens';
import { StaticFlags } from '@kesher/api/billing/capabilities';
import { createRegistry } from '@kesher/api/registry';
import { runLoad } from '@kesher/api/wallet/loads';
import { fixedClock, SIM_OTP_CODE, SimPasskeyDevice, type AdvanceableClock, type FundingPort, type FundingStatementPort } from '@kesher/ports';
import { deadlineFor, ReconJob, type PartnerTransaction } from './recon.ts';
import { FundingStatementSource } from './statement-source.ts';

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

// T-0684: the funding flow writes `ops.external_ref` rows of entity_type 'transfer' (a load, by the vendor's loadId) and 'refund'
// (a refund transfer, by the vendor's refundId), not 'journal'. The job matches those to the partner_settlement postings of the
// transfer's journals, so a real load and refund reconcile with no false breaks.
describe('ReconJob over the funding flow (T-0684, REQ-LED-004)', () => {
  const NOW = new Date('2026-11-02T09:00:00Z'); // 11:00 in Israel
  const DAY = '2026-11-02';
  let fdb: TestDatabase;
  let app: App;
  let funding: FundingPort & FundingStatementPort;
  /** The nightly shape: 05:30 Israel time on the 3rd reconciles the 2nd. */
  const jobAt = (src: { fetch: FundingStatementSource['fetch'] }, iso = '2026-11-03T03:30:00Z') => new ReconJob(fdb, src, () => new Date(iso));
  const nightly = (job: ReconJob, statementDay: string = DAY) => job.run('simulator', '2026-11-03', statementDay);

  async function registerMember(phone: string): Promise<string> {
    const s = app.services;
    const started = await s.otp.start({ phone, locale: 'en' });
    const verified = await s.otp.verify({ otpId: started.otpId, code: SIM_OTP_CODE, purpose: 'register' });
    const device = new SimPasskeyDevice();
    const r1 = await s.passkeys.register({ otpSessionToken: verified.otpSessionToken!, deviceId: 'iphone-1', deviceName: 'Dana' });
    const r2 = await s.passkeys.register({ otpSessionToken: verified.otpSessionToken!, deviceId: 'iphone-1', deviceName: 'Dana', response: await device.register(r1.options!) });
    return (await s.tokens.verifyAccess(r2.tokens!.accessToken)).partyId;
  }

  beforeAll(async () => {
    fdb = await createTestDatabase();
    const { registry, simulators } = createRegistry('sim', fixedClock(NOW.toISOString()) as AdvanceableClock);
    funding = simulators.simulators.funding;
    app = createApp({ db: fdb, registry, market: 'US', signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', clock: () => NOW, flags: new StaticFlags(undefined, { 'wallet.enabled': true }) });
  }, 60_000);
  afterAll(async () => fdb.close());

  it('a load and its closure refund match the vendor statement with no breaks; a charge we never posted is a break', async () => {
    const party = await registerMember('+12125550684');
    const a = await runLoad(app.services.loads, { payerPartyId: party, memberPartyId: party, method: 'card', amount: money(3_000n, 'USD'), paymentMethodId: 'pm_ok' }, 'recon-load-a-1', NOW);
    await runLoad(app.services.loads, { payerPartyId: party, memberPartyId: party, method: 'card', amount: money(4_500n, 'USD'), paymentMethodId: 'pm_ok' }, 'recon-load-b-1', NOW);
    await app.services.closure.close(party, NOW); // refunds both loads to the card
    expect((await fdb.query(`select 1 from ops.external_ref where entity_type = 'refund'`)).rowCount).toBe(2);

    const source = new FundingStatementSource({ provider: 'simulator', port: funding });
    const statement = await source.fetch('simulator', DAY);
    expect(statement.map((t) => t.type).sort()).toEqual(['charge', 'charge', 'refund', 'refund']);

    const clean = await nightly(jobAt(source));
    expect(clean).toMatchObject({ runDate: '2026-11-03', statementDate: DAY, matched: 4, breaks: [], withinDeadline: true });
    expect((await fdb.query(`select 1 from ops.case where kind = 'recon_break'`)).rowCount).toBe(0);

    // The vendor charged a card we have no journal for: the partner's record is the system of record.
    const ghost = await funding.createLoad({ customerId: party, method: 'card', amount: money(777n, 'USD'), paymentMethodId: 'pm_ok' }, 'recon-ghost-key-1');
    // And our side holds a charge the statement does not show (a statement missing one of ours).
    const dropped = (await app.services.loads.vendorLoadOf(a.transfer.id))!;
    const without = { fetch: async (p: string, d: string) => (await source.fetch(p, d)).filter((t) => t.externalId !== dropped) };
    const report = await nightly(jobAt(without));
    expect(report.breaks.map((b) => [b.externalId, b.reason]).sort()).toEqual([[dropped, 'missing_partner'], [ghost.loadId, 'missing_journal']].sort());
    expect(report.matched).toBe(3);
  });

  it('a partner row whose amount differs from the journal is an amount_mismatch, and a day with no activity is clean', async () => {
    const statement = await new FundingStatementSource({ provider: 'simulator', port: funding }).fetch('simulator', DAY);
    const tampered = statement.map((t) => (t.type === 'refund' ? { ...t, amount: money(t.amount.minor - 1n, t.amount.currency) } : t));
    const report = await nightly(jobAt({ fetch: async () => tampered }, '2026-11-03T03:31:00Z'));
    expect(report.breaks.filter((b) => b.reason === 'amount_mismatch').length).toBe(2);
    // Another day: nothing of ours is in its window and the statement is empty.
    expect(await nightly(jobAt({ fetch: async () => [] }), '2026-11-20')).toMatchObject({ matched: 0, breaks: [] });
  });

  it('a run that ends after 06:00 Israel time raises the deadline alert once (RUN-03)', async () => {
    const late = () => new ReconJob(fdb, { fetch: async () => [] }, () => new Date('2026-11-21T04:30:00Z')).run('simulator', '2026-11-21');
    expect((await late()).withinDeadline).toBe(false);
    await late();
    const rows = await fdb.query<{ severity: string; payload: Record<string, string> }>(`select severity, payload from ops.case where kind = 'recon_break' and payload->>'reason' = 'deadline_missed'`);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.payload).toMatchObject({ provider: 'simulator', runDate: '2026-11-21' });
  });
});
