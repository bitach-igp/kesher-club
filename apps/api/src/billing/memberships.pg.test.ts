// T-0313 on real Postgres (REQ-BIL-002, REQ-BIL-003): the race PGlite cannot show. Several requests for one member under different keys
// run on separate connections; the partial unique index lets exactly one membership in and the others' subscriptions are ended. It runs
// only when TEST_PG_URL names a migrated Postgres 16 (the desktop checker does this, see handoff/desktop/T-0313-one-membership-per-member.md).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { money, uuidv7 } from '@kesher/domain';
import type { BillingPort } from '@kesher/ports';
import { SimulatorHost } from '@kesher/simulators';
import { createPgDatabase, type PgDatabase } from '../pg.ts';
import { MembershipService } from './memberships.ts';
import { PlanService } from './plans.ts';

const url = process.env['TEST_PG_URL'];
const run = url ? describe : describe.skip;
const NOW = new Date('2026-11-10T09:00:00Z');

run('one open membership per member on real Postgres', () => {
  let db: PgDatabase;
  let memberships: MembershipService;
  let billing: BillingPort;
  const code = `pg-club-${uuidv7().slice(-8)}`;

  beforeAll(async () => {
    db = createPgDatabase(url!, { max: 10 });
    const host = new SimulatorHost();
    billing = host.registry.resolve<BillingPort>('billing', 'US');
    const plans = new PlanService(db);
    memberships = new MembershipService(db, plans, billing);
    await plans.ensurePlan(code, 'PG club');
    await plans.createVersion({ planCode: code, price: money(4_900n, 'USD'), termMonths: 10, entitlements: {}, effectiveFrom: new Date('2026-01-01T00:00:00Z') });
  });
  afterAll(async () => db.close());

  it('five simultaneous creates for one member under different keys leave exactly one membership and end every other subscription made', async () => {
    const member = uuidv7();
    const funder = uuidv7();
    const created = vi.spyOn(billing, 'createSubscription');
    const cancel = vi.spyOn(billing, 'cancel');
    const results = await Promise.allSettled(
      [1, 2, 3, 4, 5].map((n) => memberships.create({ idempotencyKey: `pg-race-${member}-${n}`, memberPartyId: member, funderPartyId: funder, funderEmail: 'f@example.com', planCode: code }, NOW)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results) if (r.status === 'rejected') expect(r.reason).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect((await db.query(`select 1 from billing.membership where member_party_id = $1`, [member])).rows).toHaveLength(1);
    // A request that sees the winner's row is refused before the vendor and makes no subscription; one that lost the insert race made
    // one and must end it. How many of each depends on timing, so: every subscription made, except the winner's, is cancelled at once.
    const made = (await Promise.all(created.mock.results.map((r) => r.value))).map((s) => s.subscriptionId);
    const kept = (await db.query<{ external_id: string }>(
      `select x.external_id from billing.membership m join ops.external_ref x on x.entity_type = 'membership' and x.entity_id = m.id and x.provider = 'stripe' where m.member_party_id = $1`,
      [member],
    )).rows.map((r) => r.external_id);
    expect(kept).toHaveLength(1);
    expect(made).toContain(kept[0]);
    expect(cancel.mock.calls.map((c) => c[0]).sort()).toEqual(made.filter((id) => id !== kept[0]).sort());
    for (const c of cancel.mock.calls) expect(c[1]).toBe('now');
    created.mockRestore();
    cancel.mockRestore();
  });
});
