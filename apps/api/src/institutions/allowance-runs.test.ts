// TST-INS-003 over HTTP (T-0607): POST /institutions/{id}/allowance-runs previews and runs a schedule under
// the institution's own finance staff. With institutions.money off it answers FEATURE_OFF; over ₪5,000 the
// run waits until a second finance member asks for the same run (REQ-INS-004); each payment is an allowance
// transfer keyed by the run and the member; a rerun pays nobody twice.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@kesher/domain';
import { SIM_OTP_CODE, SimPasskeyDevice } from '@kesher/ports';
import { SimulatorHost } from '@kesher/simulators';
import { generateSigningKey } from '../auth/tokens.ts';
import { StaticFlags } from '../billing/capabilities.ts';
import { createApp, type App } from '../app.ts';
import { dispatch } from '../server.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { workflowId } from './allowance/workflow.ts';
import { nextRunDate } from './allowance-runs.ts';

let db: TestDatabase;
let app: App;
let off: App;
const NOW = new Date('2026-11-10T09:00:00Z');
const INST = uuidv7(NOW);
const OTHER = uuidv7(NOW);
const tokens: Record<'finance1' | 'finance2' | 'otherFinance' | 'orgStaff', string> = { finance1: '', finance2: '', otherFinance: '', orgStaff: '' };
/** A fresh step-up token per access token: a run that moves money needs one (REQ-AUTH-006). */
const stepUps = new Map<string, string>();
let F1 = '';
let F2 = '';
const [OF, ST] = [uuidv7(NOW), uuidv7(NOW)];

const runAs = (a: App, token: string, institution: string, body: unknown, key = `run-${uuidv7()}`, stepUp = stepUps.get(token) ?? '') =>
  dispatch(a, { method: 'POST', url: `/v1/institutions/${institution}/allowance-runs`, headers: { authorization: `Bearer ${token}`, 'idempotency-key': key, 'x-step-up': stepUp }, rawBody: JSON.stringify(body), now: NOW });

/** A member signed up with OTP and a passkey, so their finance token can step up. */
async function signUp(a: App, phone: string): Promise<{ partyId: string; device: SimPasskeyDevice }> {
  const s = a.services;
  const started = await s.otp.start({ phone, locale: 'he' });
  const verified = await s.otp.verify({ otpId: started.otpId, code: SIM_OTP_CODE, purpose: 'register' });
  const device = new SimPasskeyDevice();
  const r1 = await s.passkeys.register({ otpSessionToken: verified.otpSessionToken!, deviceId: `web-${phone}`, deviceName: 'Console' });
  const r2 = await s.passkeys.register({ otpSessionToken: verified.otpSessionToken!, deviceId: `web-${phone}`, deviceName: 'Console', response: await device.register(r1.options!) });
  return { partyId: (await s.tokens.verifyAccess(r2.tokens!.accessToken)).partyId, device };
}

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
  const one = await signUp(app, '+972501230001');
  const two = await signUp(app, '+972501230002');
  [F1, F2] = [one.partyId, two.partyId];
  const [f1, f2, of, st] = [F1, F2, OF, ST];
  await db.query(`insert into org.staff (party_id, institution_id, role) values ($1, $5, 'finance'), ($2, $5, 'finance'), ($3, $6, 'finance'), ($4, $5, 'staff')`, [f1, f2, of, st, INST, OTHER]);
  const issue = async (partyId: string, role: string) => (await app.services.tokens.issue({ partyId, deviceId: 'web', roles: [role] })).accessToken;
  tokens.finance1 = await issue(f1, 'org_finance');
  tokens.finance2 = await issue(f2, 'org_finance');
  for (const [token, device] of [[tokens.finance1, one.device], [tokens.finance2, two.device]] as const) {
    const principal = await app.services.tokens.verifyAccess(token);
    const su = await app.services.stepUp.start(principal);
    stepUps.set(token, (await app.services.stepUp.complete(principal, await device.authenticate(su.options))).stepUpToken);
  }
  tokens.otherFinance = await issue(of, 'org_finance');
  tokens.orgStaff = await issue(st, 'org_staff');
}, 60_000);
afterAll(async () => db.close());

describe('POST /institutions/{id}/allowance-runs (TST-INS-003, T-0607)', () => {
  it('previews the members and total without moving money', async () => {
    const s = await schedule(20_000n, 3);
    const r = await runAs(app, tokens.finance1, INST, { scheduleId: s.id, date: '2026-11-10', dryRun: true });
    expect(r).toMatchObject({ status: 200, body: { workflowId: workflowId(s.id, '2026-11-10'), status: 'preview', memberCount: 3, total: { minor: '60000', currency: 'ILS' } } });
    // The preview lists each member it would pay by roster name; its rows add up to its total (T-0610).
    const rows = (r.body as { rows: { memberName: string; amount: { minor: string; currency: string } }[] }).rows;
    expect(rows.map((x) => x.memberName).sort()).toEqual(['Student 0', 'Student 1', 'Student 2']);
    expect(rows.reduce((n, x) => n + BigInt(x.amount.minor), 0n)).toBe(60_000n);
    // A preview needs no step-up; a run does (REQ-AUTH-006).
    expect((await runAs(app, tokens.finance1, INST, { scheduleId: s.id, date: '2026-11-10', dryRun: true }, undefined, '')).status).toBe(200);
    expect((await runAs(app, tokens.finance1, INST, { scheduleId: s.id, date: '2026-11-10', dryRun: false }, undefined, '')).body).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    expect((await runAs(app, tokens.finance1, INST, { scheduleId: s.id, date: '2026-11-10', dryRun: false }, undefined, stepUps.get(tokens.finance2)!)).body).toMatchObject({ code: 'STEP_UP_REQUIRED' });
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
    // Previewing a date that already ran leaves the run completed (T-0610 found it turned back into a preview).
    await runAs(app, tokens.finance1, INST, { ...body, dryRun: true });
    expect((await db.query<{ status: string }>('select status from org.allowance_run where workflow_id = $1', [wf])).rows[0]!.status).toBe('completed');
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

const read = (a: App, token: string, path: string) => dispatch(a, { method: 'GET', url: `/v1${path}`, headers: { authorization: `Bearer ${token}` }, rawBody: '', now: NOW });
type RunItem = { workflowId: string; status: string; total: { minor: string }; paidTotal: { minor: string }; paid: number; failed: number; requestedBy?: { displayName: string }; approvedBy: { displayName: string }[] };

describe('GET allowance schedules and runs (T-0609, TST-INS-003, TST-INS-004)', () => {
  it('lists active schedules with cohort and next date; a run moves the next date a week on', async () => {
    const s = await schedule(20_000n, 2);
    const list = async () => ((await read(app, tokens.orgStaff, `/institutions/${INST}/allowance-schedules`)).body as { items: { id: string; cohort: unknown; nextDate?: string; amount: unknown; cadence: string }[] }).items.find((x) => x.id === s.id);
    expect(await list()).toEqual({ id: s.id, name: 'Weekly', amount: { minor: '20000', currency: 'ILS' }, cadence: 'weekly', cohort: { kind: 'listed', memberCount: 2 }, nextDate: '2026-11-10' });
    await runAs(app, tokens.finance1, INST, { scheduleId: s.id, date: '2026-11-15', dryRun: true });
    expect((await list())!.nextDate).toBe('2026-11-10');
    await runAs(app, tokens.finance1, INST, { scheduleId: s.id, date: '2026-11-15', dryRun: false });
    expect((await list())!.nextDate).toBe('2026-11-22');
  });

  it('a completed run shows its totals equal to its journals, and who asked and approved by display name only', async () => {
    const s = await schedule(20_000n, 2);
    await runAs(app, tokens.finance1, INST, { scheduleId: s.id, date: '2026-11-20', dryRun: false });
    const wf = workflowId(s.id, '2026-11-20');
    const res = await read(app, tokens.finance2, `/institutions/${INST}/allowance-runs`);
    const run = (res.body as { items: RunItem[] }).items.find((x) => x.workflowId === wf)!;
    const journals = await db.query<{ total: string }>(`select coalesce(sum(p.amount_minor), 0)::text as total from ledger.journal j join ops.transfer t on t.id = j.transfer_id join ledger.posting p on p.journal_id = j.id where t.kind = 'allowance' and t.idempotency_key like $1 and p.amount_minor > 0`, [`${wf}:%`]);
    expect(BigInt(run.paidTotal.minor)).toBe(BigInt(journals.rows[0]!.total));
    expect(BigInt(run.total.minor)).toBe(40_000n);
    expect(run).toMatchObject({ status: 'completed', paid: 2, failed: 0, requestedBy: { displayName: 'Finance •••• 0001' }, approvedBy: [{ displayName: 'Finance •••• 0001' }] });
    const text = JSON.stringify(res.body);
    for (const secret of [F1, F2, '+972501230001']) expect(text).not.toContain(secret);
  });

  it('a run waiting for its second approver lists its first approver and has paid nothing', async () => {
    const s = await schedule(300_000n, 2);
    await runAs(app, tokens.finance1, INST, { scheduleId: s.id, date: '2026-11-21', dryRun: false });
    const items = ((await read(app, tokens.finance1, `/institutions/${INST}/allowance-runs`)).body as { items: RunItem[] }).items;
    expect(items.find((x) => x.workflowId === workflowId(s.id, '2026-11-21'))).toMatchObject({ status: 'awaiting_second_approval', total: { minor: '600000' }, paidTotal: { minor: '0' }, paid: 0, requestedBy: { displayName: 'Finance •••• 0001' }, approvedBy: [{ displayName: 'Finance •••• 0001' }] });
    await runAs(app, tokens.finance2, INST, { scheduleId: s.id, date: '2026-11-21', dryRun: false });
    const after = ((await read(app, tokens.finance1, `/institutions/${INST}/allowance-runs`)).body as { items: RunItem[] }).items.find((x) => x.workflowId === workflowId(s.id, '2026-11-21'))!;
    expect(after).toMatchObject({ status: 'completed', paidTotal: { minor: '600000' }, approvedBy: [{ displayName: 'Finance •••• 0001' }, { displayName: 'Finance •••• 0002' }] });
    const asSecond = ((await read(app, tokens.finance2, `/institutions/${INST}/allowance-runs`)).body as { items: (RunItem & { requestedByMe: boolean })[] }).items.find((x) => x.workflowId === workflowId(s.id, '2026-11-21'))!;
    expect([after, asSecond].map((x) => (x as RunItem & { requestedByMe: boolean }).requestedByMe)).toEqual([true, false]);
  });

  it("another institution's staff get 404, a member 403, and with institutions.money off FEATURE_OFF", async () => {
    for (const path of ['allowance-schedules', 'allowance-runs']) {
      expect((await read(app, tokens.otherFinance, `/institutions/${INST}/${path}`)).status).toBe(404);
      expect((await read(off, tokens.finance1, `/institutions/${INST}/${path}`)).body).toMatchObject({ code: 'FEATURE_OFF' });
    }
    const member = (await app.services.tokens.issue({ partyId: uuidv7(), deviceId: 'web', roles: ['member'] })).accessToken;
    expect((await read(app, member, `/institutions/${INST}/allowance-runs`)).status).toBe(403);
  });

  it('next dates: a month on clamps to the month end; a one-off that ran has none; an old weekly is due today', () => {
    expect(nextRunDate('monthly', '2027-01-31', '2027-01-31')).toBe('2027-02-28');
    expect(nextRunDate('monthly', '2028-01-31', '2028-01-31')).toBe('2028-02-29');
    expect(nextRunDate('once', '2026-11-01', '2026-11-10')).toBeUndefined();
    expect(nextRunDate('once', undefined, '2026-11-10')).toBe('2026-11-10');
    expect(nextRunDate('weekly', '2026-10-01', '2026-11-10')).toBe('2026-11-10');
  });
});
