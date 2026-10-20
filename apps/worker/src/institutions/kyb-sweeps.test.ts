// T-0624 keeping KYB current (TST-INS-013, TST-INS-014, REQ-INS-013, REQ-INS-014):
// - a potential match on the chair of an institution holding ₪1,000.00 with a ₪5,000.00 limit refuses a ₪500.00
//   payout and a ₪3,000.00 run, while a ₪800.00 run still pays; once compliance disposes of it as a false
//   positive, payouts open again and the next day's rescreen does not raise it again;
// - a medium-risk institution approved on 2024-10-01 reads approved_with_limits after the 2026-10-02 sweep, and
//   not after the 2026-09-30 one; a low-risk one approved the same day is not due;
// - running either job twice on a day writes nothing more; with the checks flag off the rescreen asks nothing.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DomainError, uuidv7 } from '@kesher/domain';
import { KybSimulator, type KybPort } from '@kesher/ports';
import { generateSigningKey } from '@kesher/api/auth/tokens';
import { StaticFlags } from '@kesher/api/billing/capabilities';
import { createApp, type App } from '@kesher/api/app';
import { PostgresAllowanceActivities } from '@kesher/api/institutions/allowance/activities';
import { run } from '@kesher/api/institutions/allowance/workflow';
import { createRegistry } from '@kesher/api/registry';
import { createTestDatabase, type TestDatabase } from '@kesher/api/test-db';
import { decideKyb, verifiedPayoutAccount } from '@kesher/api/test-institution';
import { KybRefresh, KybRescreen } from './kyb-sweeps.ts';

let db: TestDatabase;
let app: App;
let activities: PostgresAllowanceActivities;
const NOW = new Date('2026-11-10T09:00:00Z');
const FINANCE = uuidv7(NOW);
const CHAIR = 'Rav Chair Example';
const CLEO = { partyId: uuidv7(NOW), role: 'compliance' };
/** The simulator, except that the chair has just been listed. */
let listed = false;
const sim = new KybSimulator();
const port: KybPort = { lookupEntity: (i) => sim.lookupEntity(i), exemptStatus: (i) => sim.exemptStatus(i), screen: ({ names }) => sim.screen({ names: names.map((n) => (listed && n === CHAIR ? `Sanctioned ${n}` : n)) }) };
const rescreen = (flags = app.services.flags, at = NOW) => new KybRescreen(db, app.services.institutionKyb, flags, port, 'simulator', 'IL', () => at).run();

const refusal = async (p: Promise<unknown>): Promise<DomainError> => {
  const e = await p.then(() => undefined, (x: unknown) => x);
  expect(e).toBeInstanceOf(DomainError);
  return e as DomainError;
};
const count = async (sql: string, params: unknown[]) => ((await db.query<{ n: number }>(`select count(*)::int as n from ${sql}`, params)).rows[0]!.n);

async function institution(heldMinor: bigint): Promise<string> {
  const id = uuidv7();
  await db.query(`insert into org.institution (id, name, market) values ($1, 'Yeshivat Example', 'IL')`, [id]);
  const s = app.services;
  await s.ledger.post({ idempotencyKey: `fund:${id}:settle`, kind: 'deposit', effectiveAt: NOW, postings: [{ accountId: await s.accounts.systemAccount('partner_settlement', 'ILS'), currency: 'ILS', amountMinor: heldMinor }, { accountId: await s.accounts.institutionAccount(id, 'ILS'), currency: 'ILS', amountMinor: -heldMinor }], metadata: { institutionId: id } });
  return id;
}
async function schedule(inst: string, amountMinor: bigint): Promise<string> {
  const id = uuidv7();
  const party = uuidv7();
  await app.services.accounts.provisionMember(party);
  await db.query(`insert into org.member (id, institution_id, member_name, member_party_id, status) values ($1, $2, 'Student Example', $3, 'active')`, [uuidv7(), inst, party]);
  await db.query(`insert into org.allowance_schedule (id, institution_id, name, amount_minor, currency, cadence, member_filter, created_by) values ($1, $2, 'Weekly', $3, 'ILS', 'weekly', $4, $5)`, [id, inst, amountMinor.toString(), JSON.stringify([party]), FINANCE]);
  return id;
}

beforeAll(async () => {
  db = await createTestDatabase();
  app = createApp({ db, registry: createRegistry('sim').registry, market: 'IL', signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', clock: () => NOW, flags: new StaticFlags(undefined, { 'institutions.money': true, 'payouts.nium': true, 'institutions.kyb.checks': true }) });
  const s = app.services;
  activities = new PostgresAllowanceActivities(db, s.ledger, s.accounts, s.approvals, s.transfers, s.institutionCredit, () => NOW);
}, 60_000);
afterAll(async () => db.close());

describe('the daily sanctions rescreen (T-0624, TST-INS-013)', () => {
  it('a potential match on the chair suspends payouts and credit draws until disposed of; the institution\'s own money still runs allowances', async () => {
    const inst = await institution(100_000n);
    await decideKyb(db, inst, 'approved');
    await verifiedPayoutAccount(db, inst, 'IL620108000000099999999', 'Yeshivat Example');
    const chair = await app.services.institutionKyb.addPerson(inst, { fullName: CHAIR, roles: ['board', 'control'] }, `chair-${inst}`, CLEO, NOW);
    // A ₪5,000.00 limit, set by two admins (REQ-INS-008).
    const proposed = await app.services.institutionCredit.propose({ idempotencyKey: `limit-${inst}`, institutionId: inst, limit: { minor: '500000', currency: 'ILS' }, reason: 'Board-approved credit line' }, { partyId: uuidv7(), role: 'admin' }, NOW);
    expect((await app.services.institutionCredit.approve(proposed.id, { partyId: uuidv7(), role: 'admin' }, NOW)).limit).toBeDefined();
    const payout = (key: string, minor = '50000') => app.services.payouts.request(inst, { payee: { iban: 'IL620108000000099999999', name: 'Yeshivat Example' }, amount: { minor, currency: 'ILS' }, reference: 'transfer to own account' }, key, NOW, { kind: 'institution', requestedBy: FINANCE, requesterRole: 'finance' });

    // The first rescreen of a record nobody screened writes a clear check for the yeshiva and its chair.
    listed = false;
    expect(await rescreen()).toMatchObject({ newMatches: 0, cleared: 2, failed: 0 });
    listed = true;
    expect(await rescreen()).toMatchObject({ newMatches: 1, cleared: 0 });
    const hit = (await app.services.institutionKyb.record(inst)).checks.find((c) => c.kind === 'sanctions' && c.personId === chair.id)!;
    expect(hit).toMatchObject({ result: 'hit', provider: 'simulator', detail: { rescreen: true, matches: [{ list: 'OFAC SDN', score: 0.92 }] } });

    expect(await refusal(payout(`po-${inst}-1`))).toMatchObject({ code: 'FEATURE_OFF', extra: { kyb: 'approved', capability: 'payouts', sanctionsMatches: [hit.id] } });
    expect(await refusal(run(activities, await schedule(inst, 300_000n), '2026-11-10', FINANCE))).toMatchObject({ code: 'INSUFFICIENT_FUNDS', extra: { creditClosed: true } });
    expect(await run(activities, await schedule(inst, 80_000n), '2026-11-10', FINANCE)).toMatchObject({ status: 'completed', paid: 1 });
    expect((await app.services.accounts.institutionBalance(inst, 'ILS')).minor).toBe(20_000n);

    // Twice on a day writes nothing more.
    const checks = await count('org.kyb_check where institution_id = $1', [inst]);
    expect(await rescreen()).toMatchObject({ newMatches: 0, cleared: 0 });
    expect(await count('org.kyb_check where institution_id = $1', [inst])).toBe(checks);

    // A false positive reopens payouts (₪100.00 of the ₪200.00 left), and tomorrow's rescreen, with the same answer, does not raise it again.
    await app.services.institutionKyb.dispose(hit.id, { outcome: 'false_positive', note: 'Different date of birth on the SDN entry' }, CLEO, NOW);
    expect((await payout(`po-${inst}-2`, '10000')).state).not.toBe('failed');
    expect(await rescreen(app.services.flags, new Date('2026-11-11T05:00:00Z'))).toMatchObject({ newMatches: 0 });
    expect(await count('org.kyb_check where institution_id = $1', [inst])).toBe(checks);
  });

  it('with the checks flag off it asks the provider nothing', async () => {
    expect(await rescreen(new StaticFlags())).toMatchObject({ institutions: 0, skipped: 'flag_off' });
  });
});

describe('the KYB refresh sweep (T-0624, TST-INS-014)', () => {
  it('a medium-risk approval from 2024-10-01 drops to approved with limits on 2026-10-02, once; a low-risk one is not due', async () => {
    const approvedOn = async (risk: 'low' | 'medium') => {
      const id = await institution(1n);
      await db.query(`insert into org.kyb_decision (id, institution_id, status, risk, reasons, decided_by, decided_at) values ($1, $2, 'approved', $3, '{}', $4, '2024-10-01T08:00:00Z')`, [uuidv7(), id, risk, CLEO.partyId]);
      return id;
    };
    const medium = await approvedOn('medium');
    const low = await approvedOn('low');
    const sweep = new KybRefresh(app.services.institutionKyb, () => NOW);
    await sweep.run(new Date('2026-09-30T05:00:00Z'));
    expect((await app.services.institutionKyb.current(medium)).status).toBe('approved');
    await sweep.run(new Date('2026-10-02T05:00:00Z'));
    expect(await app.services.institutionKyb.current(medium)).toMatchObject({ status: 'approved_with_limits', risk: 'medium', reasons: ['refresh_overdue'] });
    expect((await app.services.institutionKyb.current(low)).status).toBe('approved');
    // Credit closes with it; payouts and allowances stay open (ADR-017).
    expect(await app.services.kybGate.allows(medium, 'credit')).toBe(false);
    expect(await app.services.kybGate.allows(medium, 'payouts')).toBe(true);
    // Twice on a day, or again the next day, writes nothing more.
    const decisions = await count('org.kyb_decision where institution_id = $1', [medium]);
    expect(await sweep.run(new Date('2026-10-02T06:00:00Z'))).toEqual({ lapsed: 0 });
    await sweep.run(new Date('2026-10-03T05:00:00Z'));
    expect(await count('org.kyb_decision where institution_id = $1', [medium])).toBe(decisions);
    expect((await app.services.audit.list(medium, 5)).find((e) => e.action === 'institution.kyb.decide')).toMatchObject({ actorRole: 'system', payload: { from: 'approved', to: 'approved_with_limits' } });
  });
});
