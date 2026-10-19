// TST-INS-003 over HTTP (T-0607): POST /institutions/{id}/allowance-runs previews and runs a schedule under
// the institution's own finance staff. With institutions.money off it answers FEATURE_OFF; over ₪5,000 the
// run waits until a second finance member asks for the same run (REQ-INS-004); each payment is an allowance
// transfer keyed by the run and the member; a rerun pays nobody twice.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@kesher/domain';
import { SimulatorHost } from '@kesher/simulators';
import { generateSigningKey } from '../auth/tokens.ts';
import { StaticFlags } from '../billing/capabilities.ts';
import { createApp, type App } from '../app.ts';
import { dispatch } from '../server.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { workflowId } from './allowance/workflow.ts';

let db: TestDatabase;
let app: App;
let off: App;
const NOW = new Date('2026-11-10T09:00:00Z');
const INST = uuidv7(NOW);
const OTHER = uuidv7(NOW);
const tokens: Record<'finance1' | 'finance2' | 'otherFinance' | 'orgStaff', string> = { finance1: '', finance2: '', otherFinance: '', orgStaff: '' };

const runAs = (a: App, token: string, institution: string, body: unknown, key = `run-${uuidv7()}`) =>
  dispatch(a, { method: 'POST', url: `/v1/institutions/${institution}/allowance-runs`, headers: { authorization: `Bearer ${token}`, 'idempotency-key': key }, rawBody: JSON.stringify(body), now: NOW });

/** A schedule paying `amountMinor` to `count` new members of INST. */
async function schedule(amountMinor: bigint, count: number, institution = INST): Promise<{ id: string; members: string[] }> {
  const id = uuidv7();
  const members: string[] = [];
  for (let i = 0; i < count; i++) {
    const party = uuidv7();
    members.push(party);
    await app.services.accounts.provisionMember(party);
    await db.query(`insert into org.member (id, institution_id, member_name, member_party_id, status) values ($1, $2, $3, $4, 'active')`, [uuidv7(), institution, `Student ${i}`, party]);
  }
  await db.query(`insert into org.allowance_schedule (id, institution_id, name, amount_minor, currency, cadence, member_filter, created_by) values ($1, $2, 'Weekly', $3, 'ILS', 'weekly', $4, $5)`, [id, institution, amountMinor.toString(), JSON.stringify(members), uuidv7()]);
  return { id, members };
}

beforeAll(async () => {
  db = await createTestDatabase();
  const host = new SimulatorHost();
  const signingKey = await generateSigningKey();
  const opts = { db, registry: host.registry, market: 'IL' as const, signingKey, issuer: 'https://api.kesher.example', clock: () => NOW };
  app = createApp({ ...opts, flags: new StaticFlags(undefined, { 'institutions.money': true }) });
  off = createApp({ ...opts, identity: app.services.identity, flags: new StaticFlags() });
  await db.query(`insert into org.institution (id, name, market) values ($1, 'Yeshivat Example', 'IL'), ($2, 'Other', 'IL')`, [INST, OTHER]);
  const [f1, f2, of, st] = [uuidv7(), uuidv7(), uuidv7(), uuidv7()];
  await db.query(`insert into org.staff (party_id, institution_id, role) values ($1, $5, 'finance'), ($2, $5, 'finance'), ($3, $6, 'finance'), ($4, $5, 'staff')`, [f1, f2, of, st, INST, OTHER]);
  const issue = async (partyId: string, role: string) => (await app.services.tokens.issue({ partyId, deviceId: 'web', roles: [role] })).accessToken;
  tokens.finance1 = await issue(f1, 'org_finance');
  tokens.finance2 = await issue(f2, 'org_finance');
  tokens.otherFinance = await issue(of, 'org_finance');
  tokens.orgStaff = await issue(st, 'org_staff');
}, 60_000);
afterAll(async () => db.close());

describe('POST /institutions/{id}/allowance-runs (TST-INS-003, T-0607)', () => {
  it('previews the members and total without moving money', async () => {
    const s = await schedule(20_000n, 3);
    const r = await runAs(app, tokens.finance1, INST, { scheduleId: s.id, date: '2026-11-10', dryRun: true });
    expect(r).toMatchObject({ status: 200, body: { workflowId: workflowId(s.id, '2026-11-10'), status: 'preview', memberCount: 3, total: { minor: '60000', currency: 'ILS' } } });
    expect((await db.query(`select 1 from ops.transfer where kind = 'allowance' and idempotency_key like $1`, [`${workflowId(s.id, '2026-11-10')}:%`])).rowCount).toBe(0);
  });

  it('runs: one settled allowance transfer per member, keyed by the run and the member; a rerun pays nobody twice', async () => {
    const s = await schedule(20_000n, 3);
    const body = { scheduleId: s.id, date: '2026-11-11', dryRun: false };
    const first = await runAs(app, tokens.finance1, INST, body);
    expect(first).toMatchObject({ status: 200, body: { status: 'completed', memberCount: 3, total: { minor: '60000', currency: 'ILS' }, failures: 0 } });
    const wf = workflowId(s.id, '2026-11-11');
    const rows = await db.query<{ idempotency_key: string; to_party_id: string; state: string; amount_minor: string; market: string }>(`select idempotency_key, to_party_id, state, amount_minor::text, market from ops.transfer where kind = 'allowance' and idempotency_key like $1 order by to_party_id`, [`${wf}:%`]);
    expect(rows.rows).toEqual([...s.members].sort().map((m) => ({ idempotency_key: `${wf}:${m}`, to_party_id: m, state: 'settled', amount_minor: '20000', market: 'IL' })));
    const journals = async () => (await db.query<{ n: number }>(`select count(*)::int as n from ledger.journal j join ops.transfer t on t.id = j.transfer_id where t.kind = 'allowance' and t.idempotency_key like $1`, [`${wf}:%`])).rows[0]!.n;
    expect(await journals()).toBe(3);

    expect((await runAs(app, tokens.finance1, INST, body)).body).toMatchObject({ status: 'completed' });
    expect(await journals()).toBe(3);
    for (const m of s.members) expect((await app.services.accounts.purses(m)).find((p) => p.currency === 'ILS')!.available.minor).toBe(20_000n);
  });

  it('over ₪5,000 it waits for a second finance member; the requester asking again does not count (REQ-INS-004)', async () => {
    const s = await schedule(300_000n, 2); // ₪6,000
    const body = { scheduleId: s.id, date: '2026-11-12', dryRun: false };
    expect((await runAs(app, tokens.finance1, INST, body)).body).toMatchObject({ status: 'awaiting_second_approval', memberCount: 2, total: { minor: '600000', currency: 'ILS' } });
    expect((await runAs(app, tokens.finance1, INST, body)).body).toMatchObject({ status: 'awaiting_second_approval' });
    expect((await db.query(`select 1 from ops.transfer where kind = 'allowance' and idempotency_key like $1`, [`${workflowId(s.id, '2026-11-12')}:%`])).rowCount).toBe(0);
    expect((await runAs(app, tokens.finance2, INST, body)).body).toMatchObject({ status: 'completed', total: { minor: '600000', currency: 'ILS' }, failures: 0 });
  });

  it('answers FEATURE_OFF while institutions.money is off', async () => {
    const s = await schedule(20_000n, 1);
    expect((await runAs(off, tokens.finance1, INST, { scheduleId: s.id, date: '2026-11-13', dryRun: true })).body).toMatchObject({ code: 'FEATURE_OFF' });
  });

  it('is for this institution\'s finance staff only; another institution\'s schedule is not found; the body is validated', async () => {
    const s = await schedule(20_000n, 1);
    const body = { scheduleId: s.id, date: '2026-11-14', dryRun: true };
    expect((await runAs(app, tokens.orgStaff, INST, body)).body).toMatchObject({ code: 'FORBIDDEN' });
    expect((await runAs(app, tokens.otherFinance, INST, body)).body).toMatchObject({ code: 'FORBIDDEN' });
    expect((await runAs(app, tokens.otherFinance, OTHER, body)).body).toMatchObject({ code: 'NOT_FOUND' });
    expect((await runAs(app, tokens.finance1, INST, { ...body, date: '2026-02-30' })).body).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect((await runAs(app, tokens.finance1, INST, { ...body, scheduleId: 'nope' })).body).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect((await runAs(app, tokens.finance1, INST, { scheduleId: s.id, date: '2026-11-14' })).body).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect((await runAs(app, tokens.finance1, INST, body, 'short')).body).toMatchObject({ status: 422 });
  });
});
