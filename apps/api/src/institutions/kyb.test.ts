// T-0619 institution KYB (TST-INS-011, REQ-INS-011, ADR-017):
// - a new institution is needs_more_info;
// - an amuta is refused approval while its CEO's sanctions hit is undisposed, and approved once that hit is
//   disposed of as a false positive;
// - a US school missing from IRS data is approved only on an exception with a reason;
// - screening is never excepted, and a true sanctions match bars approval;
// - a control person must hold T2, and a true PEP match makes the institution high risk;
// - a high-risk approval waits for a second compliance reviewer, never the proposer;
// - decisions, checks and dispositions are insert-only, and a replayed key answers the same decision.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DomainError, uuidv7 } from '@kesher/domain';
import { ApprovalService } from '../approvals/service.ts';
import { AuditService } from '../audit/service.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { InstitutionKyb } from './kyb.ts';

let db: TestDatabase;
let kyb: InstitutionKyb;
let audit: AuditService;
const NOW = new Date('2026-11-10T09:00:00Z');
const CLEO = { partyId: uuidv7(NOW), role: 'compliance' };
const CARL = { partyId: uuidv7(NOW), role: 'compliance' };

async function institution(name: string): Promise<string> {
  const id = uuidv7();
  await db.query(`insert into org.institution (id, name, market) values ($1, $2, 'IL')`, [id, name]);
  return id;
}
/** A member with an approved KYC session at `tier`. */
async function member(tier: 'T1' | 'T2'): Promise<string> {
  const party = uuidv7();
  await db.query(`insert into identity.kyc_session (session_id, party_id, tier, market, provider, status, started_at, expires_at, decided_at) values ($1, $2, $3, 'IL', 'simulator', 'approved', $4, $4::timestamptz + interval '1 day', $4)`, [`kyc-${party}`, party, tier, NOW]);
  return party;
}
const check = (inst: string, kind: 'registry' | 'identifier' | 'exempt_status' | 'sanctions' | 'pep', result: 'clear' | 'hit' | 'missing' | 'excepted', personId?: string, detail?: Record<string, unknown>) =>
  kyb.recordCheck(inst, { kind, result, provider: 'simulator', ...(personId ? { personId } : {}), evidenceRef: `sim:${kind}`, ...(detail ? { detail } : {}) }, CLEO.partyId, NOW);
/** An amuta whose registry, identifier and proper-management checks are clear, with a T2 chair and a T2 CEO, all screened clear. */
async function readyAmuta(): Promise<{ inst: string; chair: string; ceo: string }> {
  const inst = await institution('Yeshivat Example');
  for (const k of ['registry', 'identifier', 'exempt_status', 'sanctions', 'pep'] as const) await check(inst, k, 'clear');
  const chair = (await kyb.addPerson(inst, { fullName: 'Rav Chair', roles: ['board', 'control'], partyId: await member('T2') }, `p-${inst}-chair`, CLEO, NOW)).id;
  const ceo = (await kyb.addPerson(inst, { fullName: 'CEO Example', roles: ['control', 'signatory'], partyId: await member('T2') }, `p-${inst}-ceo`, CLEO, NOW)).id;
  for (const person of [chair, ceo]) for (const k of ['sanctions', 'pep'] as const) await check(inst, k, 'clear', person);
  return { inst, chair, ceo };
}
const refusal = async (p: Promise<unknown>): Promise<DomainError> => {
  const e = await p.then(() => undefined, (x: unknown) => x);
  expect(e).toBeInstanceOf(DomainError);
  return e as DomainError;
};

beforeAll(async () => {
  db = await createTestDatabase();
  audit = new AuditService(db);
  kyb = new InstitutionKyb(db, new ApprovalService(db), audit);
}, 60_000);
afterAll(async () => db.close());

describe('institution KYB (T-0619, TST-INS-011)', () => {
  it('a new institution is needs_more_info, and its record lists everything an approval lacks', async () => {
    const inst = await institution('New School');
    expect(await kyb.current(inst)).toEqual({ status: 'needs_more_info', reasons: [] });
    expect((await kyb.record(inst)).blocking).toEqual(['registry_not_clear', 'identifier_not_clear', 'exempt_status_not_shown', 'sanctions_not_screened:institution', 'pep_not_screened:institution', 'no_control_person']);
  });

  it('an undisposed sanctions hit on the CEO refuses approval; disposed of as a false positive, the amuta is approved', async () => {
    const { inst, ceo } = await readyAmuta();
    const hit = await check(inst, 'sanctions', 'hit', ceo, { list: 'NBCTF', score: 0.82 });
    const e = await refusal(kyb.decide(inst, { status: 'approved', risk: 'medium', reasons: ['Registry, ניהול תקין and screening clear'] }, `d-${inst}-1`, CLEO, NOW));
    expect(e).toMatchObject({ code: 'VALIDATION_FAILED', extra: { blocking: [`sanctions_hit_undisposed:${hit.id}`] } });
    expect((await kyb.current(inst)).status).toBe('needs_more_info');

    await kyb.dispose(hit.id, { outcome: 'false_positive', note: 'Different date of birth and ID number' }, CLEO, NOW);
    await expect(kyb.dispose(hit.id, { outcome: 'true_match', note: 'again' }, CLEO, NOW)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    const ok = await kyb.decide(inst, { status: 'approved', risk: 'medium', reasons: ['Registry, ניהול תקין and screening clear'] }, `d-${inst}-2`, CLEO, NOW);
    expect(ok.decision).toMatchObject({ status: 'approved', risk: 'medium', decidedBy: CLEO.partyId });
    // A replayed key answers the decision; the audit names who decided and what changed.
    expect((await kyb.decide(inst, { status: 'approved', risk: 'medium' }, `d-${inst}-2`, CLEO, NOW)).decision).toMatchObject({ status: 'approved' });
    const trail = (await audit.list(inst, 10)).map((x) => [x.action, x.payload]);
    expect(trail).toContainEqual(['institution.kyb.decide', expect.objectContaining({ from: 'needs_more_info', to: 'approved', risk: 'medium' })]);
    expect(trail.map(([a]) => a)).toContain('institution.kyb.dispose');
  });

  it('a US school missing from IRS data is approved only on an exception with a reason; screening is never excepted; a true sanctions match bars approval', async () => {
    const { inst, chair } = await readyAmuta();
    await check(inst, 'exempt_status', 'missing');
    expect((await refusal(kyb.decide(inst, { status: 'approved', risk: 'low' }, `d-${inst}-1`, CLEO, NOW))).extra['blocking']).toEqual(['exempt_status_not_shown']);
    await expect(check(inst, 'exempt_status', 'excepted')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await check(inst, 'exempt_status', 'excepted', undefined, { reason: 'Church-integrated school: exempt without filing (IRS Pub 1828); state nonprofit filing on file' });
    await check(inst, 'sanctions', 'excepted', chair, { reason: 'trying to skip screening' });
    expect((await refusal(kyb.decide(inst, { status: 'approved', risk: 'low' }, `d-${inst}-2`, CLEO, NOW))).extra['blocking']).toEqual([`sanctions_not_screened:${chair}`]);
    const hit = await check(inst, 'sanctions', 'hit', chair, { list: 'OFAC SDN' });
    await kyb.dispose(hit.id, { outcome: 'true_match', note: 'Confirmed SDN match' }, CLEO, NOW);
    expect((await refusal(kyb.decide(inst, { status: 'approved', risk: 'low' }, `d-${inst}-3`, CLEO, NOW))).extra['blocking']).toEqual([`sanctions_true_match:${hit.id}`]);
    // Rejecting needs a reason, and is not blocked by anything.
    await expect(kyb.decide(inst, { status: 'rejected' }, `d-${inst}-4`, CLEO, NOW)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect((await kyb.decide(inst, { status: 'rejected', reasons: ['Board member on the OFAC SDN list'] }, `d-${inst}-5`, CLEO, NOW)).decision).toMatchObject({ status: 'rejected' });
  });

  it('a control person below T2 blocks approval; a true PEP match makes the institution high risk', async () => {
    const { inst } = await readyAmuta();
    const treasurer = (await kyb.addPerson(inst, { fullName: 'Treasurer', roles: ['control'], partyId: await member('T1') }, `p-${inst}-t`, CLEO, NOW)).id;
    for (const k of ['sanctions', 'pep'] as const) await check(inst, k, 'clear', treasurer);
    expect((await refusal(kyb.decide(inst, { status: 'approved', risk: 'low' }, `d-${inst}-1`, CLEO, NOW))).extra['blocking']).toEqual([`control_person_not_t2:${treasurer}`]);
    await db.query(`insert into identity.kyc_session (session_id, party_id, tier, market, provider, status, started_at, expires_at, decided_at) select 'kyc2-' || party_id, party_id, 'T2', 'IL', 'simulator', 'approved', $2, $2::timestamptz + interval '1 day', $2 from org.kyb_person where id = $1`, [treasurer, NOW]);
    const pep = await check(inst, 'pep', 'hit', treasurer, { role: 'Local council member' });
    await kyb.dispose(pep.id, { outcome: 'true_match', note: 'Sits on the local council' }, CLEO, NOW);
    expect((await refusal(kyb.decide(inst, { status: 'approved', risk: 'medium' }, `d-${inst}-2`, CLEO, NOW))).extra['blocking']).toEqual(['pep_requires_high_risk']);
  });

  it('a high-risk approval waits for a second compliance reviewer; the proposer cannot be the second', async () => {
    const { inst } = await readyAmuta();
    const proposed = await kyb.decide(inst, { status: 'approved_with_limits', risk: 'high', reasons: ['Foreign funding; EDD done'] }, `d-${inst}-1`, CLEO, NOW);
    expect(proposed.approval).toMatchObject({ kind: 'kyb_decision', status: 'awaiting_second_approval', approvals: 1 });
    expect((await kyb.current(inst)).status).toBe('needs_more_info');
    expect((await kyb.record(inst)).pendingApproval?.id).toBe(proposed.approval!.id);
    await expect(kyb.approveDecision(proposed.approval!.id, CLEO, NOW)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(kyb.approveDecision(proposed.approval!.id, { partyId: uuidv7(), role: 'admin' }, NOW)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const second = await kyb.approveDecision(proposed.approval!.id, CARL, NOW);
    expect(second).toMatchObject({ approval: { status: 'approved' }, decision: { status: 'approved_with_limits', risk: 'high', decidedBy: CARL.partyId } });
    expect((await audit.list(inst, 10)).find((x) => x.action === 'institution.kyb.decide')?.payload).toMatchObject({ approvalId: proposed.approval!.id, proposedBy: CLEO.partyId });
  });

  it('checks, dispositions and decisions cannot be updated or deleted by the app role; the latest row is the state', async () => {
    const { inst } = await readyAmuta();
    await kyb.decide(inst, { status: 'needs_more_info', reasons: ['Waiting for the signatory protocol'] }, `d-${inst}-1`, CLEO, NOW);
    for (const sql of ['update org.kyb_decision set status = $1', 'delete from org.kyb_check where institution_id = $1', 'update org.kyb_disposition set note = $1']) {
      await expect(db.asRole('club_app', (c) => c.query(sql, [sql.includes('kyb_check') ? inst : 'approved']))).rejects.toThrow(/permission denied/);
    }
    // A person's member party is the one thing that may be linked later.
    await db.asRole('club_app', (c) => c.query(`update org.kyb_person set party_id = $1 where institution_id = $2 and full_name = 'Rav Chair'`, [uuidv7(), inst]));
  });
});
