// The exempt-purpose guard (T-0752, REQ-WAL-002, ADR-018 "Decision, 2026-11-18"). TST-WAL-002: a member sub-account is opened only for a
// stated purpose from a configured list (no default), behind `wallet.subAccounts`, for an eligible member with owner details or an
// invitation, once per member and purpose. Over the MemberSubAccountSimulator and PGlite; the port is spied on to count calls.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DomainError, uuidv7 } from '@kesher/domain';
import { MemberSubAccountError, MemberSubAccountSimulator, type EnsureSubAccountInput } from '@kesher/ports';
import { StaticFlags } from '../billing/capabilities.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { purposeHash, SubAccountService, type OwnerDetailsReader, type SubAccountOwnerDetails } from './sub-accounts.ts';

const NOW = new Date('2026-11-18T09:00:00Z');
const PURPOSE = 'test-purpose-a';
const OWNER = { firstName: 'Test', lastName: 'Owner', email: 'owner@example.test', mobile: '+14155550123' };

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
}, 60_000);
afterAll(() => db.close());

class SpySim extends MemberSubAccountSimulator {
  calls: EnsureSubAccountInput[] = [];
  idemKeys: string[] = [];
  override ensureSubAccount(input: EnsureSubAccountInput, key: string) {
    this.calls.push(input);
    this.idemKeys.push(key);
    return super.ensureSubAccount(input, key);
  }
}

const shared = new SpySim();

function build(o: { flag?: boolean; purposes?: readonly string[]; details?: SubAccountOwnerDetails | undefined; eligible?: (id: string) => Promise<boolean>; port?: unknown; omitEligible?: boolean } = {}) {
  // One simulator for the file: its ref sequence stays unique across tests, as vendor ids are (ops.external_ref is keyed on them).
  const sim = shared;
  sim.calls = [];
  sim.idemKeys = [];
  const reads: string[] = [];
  const reader: OwnerDetailsReader = {
    read: async (id) => {
      reads.push(id);
      return 'details' in o ? o.details : { owner: OWNER };
    },
  };
  const flags = new StaticFlags(undefined, { 'wallet.subAccounts': o.flag ?? true });
  const service = new SubAccountService({
    db,
    flags,
    funding: 'port' in o ? o.port : sim,
    details: reader,
    purposes: o.purposes ?? [PURPOSE, 'test-purpose-b'],
    provider: 'crowded',
    ...(o.omitEligible ? {} : { eligible: o.eligible ?? (async () => true) }),
  });
  return { sim, service, reads };
}

const refs = (id: string) => db.query<{ entity_type: string; external_id: string }>(`select entity_type, external_id from ops.external_ref where entity_id = $1 order by entity_type`, [id]);
const cases = (id: string) => db.query<{ kind: string; severity: string; dedupe_key: string; payload: unknown }>(`select kind, severity, dedupe_key, payload from ops.case where dedupe_key = $1`, [`subaccount-owner:${id}`]);
const refused = async (p: Promise<unknown>) => {
  const e = await p.then(() => undefined, (x: unknown) => x);
  expect(e).toBeInstanceOf(DomainError);
  return e as DomainError;
};

describe('SubAccountService.open (T-0752)', () => {
  it('is FEATURE_OFF with the flag off and nothing is read or called', async () => {
    const id = uuidv7();
    const { service, sim, reads } = build({ flag: false });
    const e = await refused(service.open({ partyId: id, purpose: PURPOSE }, NOW));
    expect(e.code).toBe('FEATURE_OFF');
    expect(sim.calls).toHaveLength(0);
    expect(reads).toHaveLength(0);
    expect((await refs(id)).rows).toHaveLength(0);
  });

  it('is FEATURE_OFF when the funding binding is not a member sub-account port', async () => {
    const { service } = build({ port: { ensureAccount: () => undefined } });
    expect((await refused(service.open({ partyId: uuidv7(), purpose: PURPOSE }, NOW))).code).toBe('FEATURE_OFF');
  });

  it('refuses a purpose that is not configured: 422 purposeRequired, before any read, vendor call or row', async () => {
    const id = uuidv7();
    const { service, sim, reads } = build();
    for (const purpose of ['', '   ', 'not-listed', 'test-purpose']) {
      const e = await refused(service.open({ partyId: id, purpose }, NOW));
      expect(e.code).toBe('VALIDATION_FAILED');
      expect(e.extra).toMatchObject({ purposeRequired: true });
    }
    expect(sim.calls).toHaveLength(0);
    expect(reads).toHaveLength(0);
    expect((await refs(id)).rows).toHaveLength(0);
  });

  it('refuses every purpose when the list is empty (no default)', async () => {
    const { service, sim } = build({ purposes: [] });
    const e = await refused(service.open({ partyId: uuidv7(), purpose: PURPOSE }, NOW));
    expect(e.extra).toMatchObject({ purposeRequired: true });
    expect(sim.calls).toHaveLength(0);
  });

  it('refuses by default (a minor, or no eligibility check at all): nothing is called', async () => {
    for (const b of [build({ omitEligible: true }), build({ eligible: async () => false })]) {
      const id = uuidv7();
      const e = await refused(b.service.open({ partyId: id, purpose: PURPOSE }, NOW));
      expect(e.code).toBe('VALIDATION_FAILED');
      expect(e.extra).toMatchObject({ eligibilityRequired: true });
      expect(b.sim.calls).toHaveLength(0);
      expect(b.reads).toHaveLength(0);
      expect((await refs(id)).rows).toHaveLength(0);
    }
  });

  it('refuses a member with no owner details and no invitation: detailsRequired', async () => {
    const id = uuidv7();
    const { service, sim } = build({ details: undefined });
    const e = await refused(service.open({ partyId: id, purpose: PURPOSE }, NOW));
    expect(e.code).toBe('VALIDATION_FAILED');
    expect(e.extra).toMatchObject({ detailsRequired: true });
    expect(sim.calls).toHaveLength(0);
    expect((await refs(id)).rows).toHaveLength(0);
  });

  it('opens once: one port call under funding-subaccount:{partyId}:{purpose}, two refs; a second open asks nobody and answers the same refs', async () => {
    const id = uuidv7();
    const { service, sim, reads } = build();
    const first = await service.open({ partyId: id, purpose: PURPOSE }, NOW);
    expect(sim.calls).toHaveLength(1);
    expect(sim.idemKeys).toEqual([`funding-subaccount:${id}:${purposeHash(PURPOSE)}`]);
    expect(sim.calls[0]).toMatchObject({ partyId: id, purpose: PURPOSE, owner: OWNER });
    expect(first).toMatchObject({ created: true, status: 'open', ownerStatus: 'active' });
    expect(first.subAccountRef).toMatch(/^s:[A-Za-z0-9_-]+$/);
    expect(first.accountRef.startsWith(`${first.subAccountRef}:`)).toBe(true);
    expect((await refs(id)).rows).toEqual([
      { entity_type: 'funding_account', external_id: first.accountRef },
      { entity_type: 'funding_subaccount', external_id: first.subAccountRef },
      { entity_type: 'funding_subaccount_purpose', external_id: `p:${id}:${purposeHash(PURPOSE)}` },
    ]);

    const readsBefore = reads.length;
    const second = await service.open({ partyId: id, purpose: PURPOSE }, NOW);
    expect(sim.calls).toHaveLength(1);
    expect(reads.length).toBe(readsBefore);
    expect(second).toMatchObject({ created: false, subAccountRef: first.subAccountRef, accountRef: first.accountRef });
    expect((await refs(id)).rows).toHaveLength(3);
  });

  it('refuses a different purpose for a member who has a sub-account: 409, no port call, nothing written, no purpose echoed', async () => {
    const id = uuidv7();
    const { service, sim } = build();
    const first = await service.open({ partyId: id, purpose: PURPOSE }, NOW);
    const before = (await refs(id)).rows;
    const e = await refused(service.open({ partyId: id, purpose: 'test-purpose-b' }, NOW));
    expect(e.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(e.message).toBe('This member already has a sub-account for another purpose');
    expect(JSON.stringify(e.extra)).not.toContain('purpose-b');
    expect(sim.calls).toHaveLength(1);
    expect((await refs(id)).rows).toEqual(before);
    expect((await service.open({ partyId: id, purpose: PURPOSE }, NOW)).subAccountRef).toBe(first.subAccountRef);
  });

  it('replays the same purpose written with other case or edge spaces', async () => {
    const id = uuidv7();
    const { service, sim } = build({ purposes: ['Test Purpose A'] });
    const first = await service.open({ partyId: id, purpose: 'Test Purpose A' }, NOW);
    for (const v of ['test purpose a', '  TEST PURPOSE A  ']) expect(await service.open({ partyId: id, purpose: v }, NOW)).toMatchObject({ created: false, subAccountRef: first.subAccountRef });
    expect(sim.calls).toHaveLength(1);
  });

  it('refuses conservatively when refs exist with no purpose marker (older or partial state)', async () => {
    const id = uuidv7();
    const { service, sim } = build();
    await db.query(`insert into ops.external_ref (entity_type, entity_id, provider, external_id) values ('funding_subaccount', $1, 'crowded', $2), ('funding_account', $1, 'crowded', $3)`, [id, `s:old-${id}`, `s:old-${id}:a`]);
    const e = await refused(service.open({ partyId: id, purpose: PURPOSE }, NOW));
    expect(e.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(sim.calls).toHaveLength(0);
  });

  it('keeps the port key within 128 characters for a 200-character purpose', async () => {
    const id = uuidv7();
    const long = 'x'.repeat(200);
    const { service, sim } = build({ purposes: [long] });
    await service.open({ partyId: id, purpose: long }, NOW);
    expect(sim.idemKeys[0]!.length).toBeLessThanOrEqual(128);
    expect(sim.idemKeys[0]).toBe(`funding-subaccount:${id}:${purposeHash(long)}`);
  });

  it('rolls the refs back when a racing open stored another purpose first (a marker that differs after the write)', async () => {
    const id = uuidv7();
    const { service } = build();
    await db.query(`insert into ops.external_ref (entity_type, entity_id, provider, external_id) values ('funding_subaccount_purpose', $1, 'crowded', $2)`, [id, `p:${id}:${purposeHash('test-purpose-b')}`]);
    const e = await refused(service.open({ partyId: id, purpose: PURPOSE }, NOW));
    expect(e.code).toBe('IDEMPOTENCY_CONFLICT');
    expect((await refs(id)).rows.map((r) => r.entity_type)).toEqual(['funding_subaccount_purpose']);
  });

  it('matches the purpose without case or edge spaces and sends the configured spelling', async () => {
    const id = uuidv7();
    const { service, sim } = build({ purposes: ['Test Purpose A'] });
    await service.open({ partyId: id, purpose: '  test purpose a ' }, NOW);
    expect(sim.calls[0]!.purpose).toBe('Test Purpose A');
  });

  it('passes an invitation email when there is no owner', async () => {
    const id = uuidv7();
    const { service, sim } = build({ details: { inviteEmail: 'invitee@example.test' } });
    const r = await service.open({ partyId: id, purpose: PURPOSE }, NOW);
    expect(sim.calls[0]).toMatchObject({ inviteEmail: 'invitee@example.test' });
    expect(sim.calls[0]!.owner).toBeUndefined();
    expect(r.ownerStatus).toBe('invited');
  });

  it('refuses a frozen sub-account naming the status only, and writes no refs (a later open asks the vendor again)', async () => {
    const id = uuidv7();
    const { service, sim } = build({ details: { owner: { ...OWNER, email: 'frozen@example.test' } } });
    const e = await refused(service.open({ partyId: id, purpose: PURPOSE }, NOW));
    expect(e.code).toBe('FEATURE_OFF');
    expect(e.message).toContain('frozen');
    expect(e.message).not.toContain('example.test');
    expect((await refs(id)).rows).toHaveLength(0);
    await refused(service.open({ partyId: id, purpose: PURPOSE }, NOW));
    expect(sim.calls).toHaveLength(2);
  });

  it('refuses a closed sub-account the same way, with no refs', async () => {
    const other = uuidv7();
    const fake = { ensureSubAccount: async () => ({ subAccountRef: 's:c1', accountRef: 's:c1:a1', status: 'closed', ownerStatus: 'active' }), subAccount: async () => ({}) };
    const e = await refused(build({ port: fake }).service.open({ partyId: other, purpose: PURPOSE }, NOW));
    expect(e.code).toBe('FEATURE_OFF');
    expect(e.message).toContain('closed');
    expect((await refs(other)).rows).toHaveLength(0);
  });

  it('keeps a sub-account whose owner failed and opens ONE medium case with no personal data', async () => {
    const id = uuidv7();
    const { service } = build({ details: { owner: { ...OWNER, email: 'ownerfail@example.test', firstName: 'Zelda', mobile: '+14155550199' } } });
    const r = await service.open({ partyId: id, purpose: PURPOSE }, NOW);
    expect(r).toMatchObject({ status: 'open', ownerStatus: 'failed' });
    expect((await refs(id)).rows).toHaveLength(4);
    expect((await refs(id)).rows).toContainEqual({ entity_type: 'funding_subaccount_owner', external_id: `o:${id}:failed` });
    const c = await cases(id);
    expect(c.rows).toHaveLength(1);
    expect(c.rows[0]).toMatchObject({ kind: 'subaccount_owner_failed', severity: 'medium', dedupe_key: `subaccount-owner:${id}` });
    expect(c.rows[0]!.payload).toEqual({ partyId: id });
    const text = JSON.stringify(c.rows[0]);
    for (const pii of ['Zelda', '+14155550199', 'ownerfail@example.test']) expect(text).not.toContain(pii);
    await service.open({ partyId: id, purpose: PURPOSE }, NOW);
    expect((await cases(id)).rows).toHaveLength(1);
  });

  it('never puts a name, mobile or email into a thrown message when the details are refused', async () => {
    const { service } = build({ details: { owner: { ...OWNER, firstName: 'Zelda', email: 'bad-email' } } });
    const e = await service.open({ partyId: uuidv7(), purpose: PURPOSE }, NOW).then(() => undefined, (x: unknown) => x as Error);
    expect(e).toBeDefined();
    for (const pii of ['Zelda', '+14155550123', 'bad-email']) expect(e!.message + JSON.stringify((e as DomainError).extra ?? {})).not.toContain(pii);
  });
});

const quotaCase = () => db.query<{ kind: string; severity: string; status: string; payload: Record<string, unknown>; opened_at: Date }>(`select kind, severity, status, payload, opened_at from ops.case where dedupe_key = 'subaccount-quota'`);
const resolveQuotaCase = () => db.query(`update ops.case set status = 'resolved', resolved_at = $1, resolution = 'quota raised' where dedupe_key = 'subaccount-quota'`, [NOW]);

describe('a full sub-account quota (T-0753)', () => {
  // The file's one simulator keeps vendor refs unique (ops.external_ref is keyed on them); each test fills it and the hook empties the quota.
  const full = () => {
    shared.setQuota(0);
    return shared;
  };
  afterEach(() => shared.setQuota(Number.POSITIVE_INFINITY));

  it('answers 503 PROVIDER_UNAVAILABLE with reason subaccount_quota, calls the port once, writes no ref and opens ONE high case', async () => {
    await db.query(`delete from ops.case where dedupe_key = 'subaccount-quota'`);
    const id = uuidv7();
    const { service, sim } = build({ details: { owner: { ...OWNER, firstName: 'Zelda', email: 'quota@example.test' } } });
    full();
    const e = await refused(service.open({ partyId: id, purpose: PURPOSE }, NOW));
    expect(e.code).toBe('PROVIDER_UNAVAILABLE');
    expect(e.extra).toMatchObject({ reason: 'subaccount_quota' });
    expect(sim.calls).toHaveLength(1);
    expect((await refs(id)).rows).toHaveLength(0);
    const c = await quotaCase();
    expect(c.rows).toHaveLength(1);
    expect(c.rows[0]).toMatchObject({ kind: 'subaccount_quota_full', severity: 'high', status: 'open', payload: { refused: 1 } });
    // Fixed text, no vendor words and nothing personal anywhere in the error or the case.
    const text = e.message + JSON.stringify(e.extra ?? {}) + JSON.stringify(c.rows[0]!.payload);
    for (const leak of ['Zelda', 'quota@example.test', id, 'limit has been reached', 'QUOTA_EXCEEDED']) expect(text).not.toContain(leak);
  });

  it('a second refused member updates the same case (count 2) and opens no other', async () => {
    await db.query(`delete from ops.case where dedupe_key = 'subaccount-quota'`);
    const { service, sim } = build();
    full();
    await refused(service.open({ partyId: uuidv7(), purpose: PURPOSE }, NOW));
    await refused(service.open({ partyId: uuidv7(), purpose: PURPOSE }, new Date(NOW.getTime() + 60_000)));
    const c = await quotaCase();
    expect(c.rows).toHaveLength(1);
    expect(c.rows[0]!.payload).toEqual({ refused: 2 });
    expect(c.rows[0]!.opened_at.toISOString()).toBe(NOW.toISOString());
    expect(sim.calls).toHaveLength(2);
  });

  it('still answers the refs of a member who already has a sub-account: the rows are read first and the port is not called', async () => {
    const id = uuidv7();
    const { service, sim } = build();
    const first = await service.open({ partyId: id, purpose: PURPOSE }, NOW);
    sim.setQuota(0);
    sim.calls = [];
    const again = await service.open({ partyId: id, purpose: PURPOSE }, NOW);
    expect(again).toMatchObject({ created: false, subAccountRef: first.subAccountRef, accountRef: first.accountRef });
    expect(sim.calls).toHaveLength(0);
  });

  it('after ops raises the quota and resolves the case, the next open succeeds with the same key and ONE sub-account exists', async () => {
    await db.query(`delete from ops.case where dedupe_key = 'subaccount-quota'`);
    const id = uuidv7();
    const { service, sim } = build();
    full();
    await refused(service.open({ partyId: id, purpose: PURPOSE }, NOW));
    sim.setQuota(Number.POSITIVE_INFINITY);
    await resolveQuotaCase();
    const r = await service.open({ partyId: id, purpose: PURPOSE }, NOW);
    expect(r.created).toBe(true);
    expect(sim.idemKeys[1]).toBe(sim.idemKeys[0]);
    expect((await refs(id)).rows.filter((x) => x.entity_type === 'funding_subaccount')).toHaveLength(1);
    expect((await service.open({ partyId: id, purpose: PURPOSE }, NOW)).created).toBe(false);
    expect(sim.calls).toHaveLength(2);
  });

  it('a later refusal after the case was resolved reopens it with a fresh count', async () => {
    await db.query(`delete from ops.case where dedupe_key = 'subaccount-quota'`);
    const { service } = build();
    full();
    await refused(service.open({ partyId: uuidv7(), purpose: PURPOSE }, NOW));
    await resolveQuotaCase();
    const later = new Date(NOW.getTime() + 3_600_000);
    await refused(service.open({ partyId: uuidv7(), purpose: PURPOSE }, later));
    const c = await quotaCase();
    expect(c.rows).toHaveLength(1);
    expect(c.rows[0]).toMatchObject({ status: 'open', payload: { refused: 1 } });
    expect(c.rows[0]!.opened_at.toISOString()).toBe(later.toISOString());
  });

  it('other port errors still propagate unchanged and open no quota case', async () => {
    await db.query(`delete from ops.case where dedupe_key = 'subaccount-quota'`);
    const port = new SpySim();
    port.ensureSubAccount = () => Promise.reject(new MemberSubAccountError('PROVIDER_UNAVAILABLE', 'The provider is unavailable'));
    const { service } = build({ port });
    const e = await service.open({ partyId: uuidv7(), purpose: PURPOSE }, NOW).then(() => undefined, (x: unknown) => x as Error);
    expect(e?.name).toBe('MemberSubAccountError');
    expect((await quotaCase()).rows).toHaveLength(0);
  });
});
