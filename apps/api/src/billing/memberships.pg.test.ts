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

  it('five simultaneous creates for one member under different keys leave exactly one membership and end the other four subscriptions', async () => {
    const member = uuidv7();
    const funder = uuidv7();
    const cancel = vi.spyOn(billing, 'cancel');
    const results = await Promise.allSettled(
      [1, 2, 3, 4, 5].map((n) => memberships.create({ idempotencyKey: `pg-race-${member}-${n}`, memberPartyId: member, funderPartyId: funder, funderEmail: 'f@example.com', planCode: code }, NOW)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results) if (r.status === 'rejected') expect(r.reason).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect((await db.query(`select 1 from billing.membership where member_party_id = $1`, [member])).rows).toHaveLength(1);
    expect(cancel).toHaveBeenCalledTimes(4);
    cancel.mockRestore();
  });
});
