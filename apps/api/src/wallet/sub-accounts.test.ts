// The exempt-purpose guard (T-0752, REQ-WAL-002, ADR-018 "Decision, 2026-11-18"). TST-WAL-002: a member sub-account is opened only for a
// stated purpose from a configured list (no default), behind `wallet.subAccounts`, for an eligible member with owner details or an
// invitation, once per member and purpose. Over the MemberSubAccountSimulator and PGlite; the port is spied on to count calls.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DomainError, uuidv7 } from '@kesher/domain';
import { MemberSubAccountSimulator, type EnsureSubAccountInput } from '@kesher/ports';
import { StaticFlags } from '../billing/capabilities.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { SubAccountService, type OwnerDetailsReader, type SubAccountOwnerDetails } from './sub-accounts.ts';

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
    expect(sim.idemKeys).toEqual([`funding-subaccount:${id}:${PURPOSE}`]);
    expect(sim.calls[0]).toMatchObject({ partyId: id, purpose: PURPOSE, owner: OWNER });
    expect(first).toMatchObject({ created: true, status: 'open', ownerStatus: 'active' });
    expect(first.subAccountRef).toMatch(/^s:[A-Za-z0-9_-]+$/);
    expect(first.accountRef.startsWith(`${first.subAccountRef}:`)).toBe(true);
    expect((await refs(id)).rows).toEqual([
      { entity_type: 'funding_account', external_id: first.accountRef },
      { entity_type: 'funding_subaccount', external_id: first.subAccountRef },
    ]);

    const readsBefore = reads.length;
    const second = await service.open({ partyId: id, purpose: PURPOSE }, NOW);
    expect(sim.calls).toHaveLength(1);
    expect(reads.length).toBe(readsBefore);
    expect(second).toMatchObject({ created: false, subAccountRef: first.subAccountRef, accountRef: first.accountRef });
    expect((await refs(id)).rows).toHaveLength(2);
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
    expect((await refs(id)).rows).toHaveLength(2);
    const c = await cases(id);
    expect(c.rows).toHaveLength(1);
    expect(c.rows[0]).toMatchObject({ kind: 'subaccount_owner_failed', severity: 'medium', dedupe_key: `subaccount-owner:${id}` });
    expect(c.rows[0]!.payload).toEqual({ partyId: id });
    const text = JSON.stringify(c.rows[0]);
    for (const pii of ['Zelda', '+14155550199', 'ownerfail@example.test']) expect(text).not.toContain(pii);
    await service.open({ partyId: id, purpose: PURPOSE }, NOW);
    expect((await cases(id)).rows).toHaveLength(1);
  });

  it('lets a port error through without personal data (T-0753 maps the codes)', async () => {
    const { service, sim } = build({ details: { owner: { ...OWNER, email: 'outage@example.test', firstName: 'Zelda' } } });
    sim.setQuota(100);
    const e = await service.open({ partyId: uuidv7(), purpose: PURPOSE }, NOW).then(() => undefined, (x: unknown) => x as Error);
    expect(e?.name).toBe('MemberSubAccountError');
    expect(e!.message).not.toContain('Zelda');
    expect(e!.message).not.toContain('outage@example.test');
  });

  it('never puts a name, mobile or email into a thrown message when the details are refused', async () => {
    const { service } = build({ details: { owner: { ...OWNER, firstName: 'Zelda', email: 'bad-email' } } });
    const e = await service.open({ partyId: uuidv7(), purpose: PURPOSE }, NOW).then(() => undefined, (x: unknown) => x as Error);
    expect(e).toBeDefined();
    for (const pii of ['Zelda', '+14155550123', 'bad-email']) expect(e!.message + JSON.stringify((e as DomainError).extra ?? {})).not.toContain(pii);
  });
});
