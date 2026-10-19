// ExpireIntentsJob (T-1010, REQ-AGT-006): pending intents past their 24 h become expired, in batches, once;
// one whose money already started under `intent:{id}` is marked approved instead; decided and young ones
// are left alone; a repeat finds nothing.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { money, uuidv7 } from '@kesher/domain';
import { AuthSimulator } from '@kesher/ports';
import { InMemoryIdentityRepository } from '@kesher/api/auth/repository';
import { StepUpService } from '@kesher/api/auth/step-up';
import { StaticFlags } from '@kesher/api/billing/capabilities';
import { INTENT_TTL_MS, IntentService, intentKey } from '@kesher/api/intents/service';
import { TransferService } from '@kesher/api/transfers/service';
import { createTestDatabase, type TestDatabase } from '@kesher/api/test-db';
import { EXPIRE_INTENTS_CYCLE_MS, ExpireIntentsJob } from './expire-intents.ts';

let db: TestDatabase;
const NOW = new Date('2026-11-10T09:00:00Z');
let now = NOW;
let intents: IntentService;
let transfers: TransferService;
const unused = () => Promise.reject(new Error('the sweep moves no money'));

beforeAll(async () => {
  db = await createTestDatabase();
  transfers = new TransferService(db);
  intents = new IntentService(db, transfers, new StepUpService(new AuthSimulator(), new InMemoryIdentityRepository(), { now: () => now }), { p2p: { send: unused }, loads: { request: unused } }, new StaticFlags());
}, 60_000);
afterAll(async () => db.close());

describe('the intent expiry job', () => {
  it('runs every 15 minutes, expires what is past 24 h in batches, marks a started send approved, once', async () => {
    expect(EXPIRE_INTENTS_CYCLE_MS).toBe(15 * 60_000);
    const party = uuidv7(NOW);
    const grantId = uuidv7(NOW);
    const propose = (kind: 'p2p' | 'limit_change') => intents.propose({ grantId, partyId: party, kind, payload: kind === 'p2p' ? { toPartyId: uuidv7(NOW), amount: { minor: '100', currency: 'ILS' } } : { action: 'unfreeze', memberPartyId: party } }, now);
    now = NOW;
    const old: string[] = [];
    for (let i = 0; i < 5; i += 1) old.push((await propose('limit_change')).id);
    const started = (await propose('p2p')).id;
    await transfers.create({ idempotencyKey: intentKey(started), kind: 'p2p', fromPartyId: party, toPartyId: uuidv7(NOW), amount: money(100n, 'ILS') }, now);
    const rejected = (await propose('p2p')).id;
    await db.query(`update agent.pending_intent set status = 'rejected', decided_at = $2, decided_by = $3 where id = $1`, [rejected, now, party]);
    now = new Date(NOW.getTime() + 60_000);
    const young = (await propose('limit_change')).id;

    now = new Date(NOW.getTime() + INTENT_TTL_MS + 1);
    const job = new ExpireIntentsJob(intents, () => now, 2);
    expect(await job.run()).toEqual({ ranAt: now.toISOString(), expired: 5, approved: 1 });
    for (const id of old) expect((await intents.get(id))!.status).toBe('expired');
    expect((await intents.get(started))!).toMatchObject({ status: 'approved', decidedBy: party });
    expect((await intents.get(rejected))!.status).toBe('rejected');
    expect((await intents.get(young))!.status).toBe('pending');
    expect(await job.run()).toEqual({ ranAt: now.toISOString(), expired: 0, approved: 0 });
  });
});
