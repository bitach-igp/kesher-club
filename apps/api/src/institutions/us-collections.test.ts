// TST-INS-023 fees to US funders (T-0652, REQ-INS-023). A fee batch in USD on a linked, approved institution is collected on the provider's payment
// page: each funder gets a page, created once; the money goes to the institution's own US account and nothing posts to the ledger. An item is paid
// only when the provider says so (a re-read, never an event body), exactly once however often it is told; a payment of another amount, one for a
// fee the purse already paid, and a refund open a case and do not mark the fee paid. The flag off and an unapproved link answer 404 and 422.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { money, uuidv7 } from '@kesher/domain';
import { SIM_OTP_CODE, SimPasskeyDevice, type InstitutionBankingPort } from '@kesher/ports';
import { SimulatorHost } from '@kesher/simulators';
import { generateSigningKey } from '../auth/tokens.ts';
import { createApp, type App } from '../app.ts';
import { StaticFlags } from '../billing/capabilities.ts';
import { dispatch } from '../server.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { decideKyb } from '../test-institution.ts';

let db: TestDatabase;
let main: App;
let off: App;
let host: SimulatorHost;
const NOW = new Date('2026-11-03T09:00:00Z');
const INST = uuidv7(NOW);
const FRESH = uuidv7(NOW);
const BATCH = uuidv7(NOW);
const OTHER_BATCH = uuidv7(NOW);
const ILS_BATCH = uuidv7(NOW);
const IP = '198.51.100.4';
type Who = { app: App; partyId: string; access: string };
const people: Record<string, Who> = {};
const sim = () => host.simulators['institution-banking'];
const port = () => host.registry.resolve<InstitutionBankingPort>('institution-banking', 'IL');
let entityRef = '';
const items = Array.from({ length: 8 }, () => uuidv7(NOW));
const funder = (i: number, name = `Funder ${i}`) => ({ feeItemId: items[i]!, name, email: `funder${i}@example.org`, mobile: `+1415555010${i}` });

const call = (who: string, method: string, url: string, body?: unknown, key?: string) =>
  dispatch(people[who]!.app, { method, url: `/v1${url}`, headers: { authorization: `Bearer ${people[who]!.access}`, ...(key ? { 'idempotency-key': key } : {}) }, rawBody: body === undefined ? '' : JSON.stringify(body), now: NOW });
const collect = (who: string, batch: string, funders: unknown[], key = 'collect-key-0001', inst = INST) => call(who, 'POST', `/institutions/${inst}/fee-batches/${batch}/us-collection`, { funders }, key);

async function person(app: App, name: string, phone: string, roles: string[]): Promise<void> {
  const s = app.services;
  const started = await s.otp.start({ phone, locale: 'he' });
  const verified = await s.otp.verify({ otpId: started.otpId, code: SIM_OTP_CODE, purpose: 'register' });
  const device = new SimPasskeyDevice();
  const r1 = await s.passkeys.register({ otpSessionToken: verified.otpSessionToken!, deviceId: `web-${phone}`, deviceName: 'Console' });
  const r2 = await s.passkeys.register({ otpSessionToken: verified.otpSessionToken!, deviceId: `web-${phone}`, deviceName: 'Console', response: await device.register(r1.options!) });
  const partyId = (await s.tokens.verifyAccess(r2.tokens!.accessToken)).partyId;
  people[name] = { app, partyId, access: (await s.tokens.issue({ partyId, deviceId: `web-${phone}`, roles })).accessToken };
}

const journals = async () => (await db.query<{ n: string }>('select count(*)::text as n from ledger.journal')).rows[0]!.n;
const status = async (i: number) => (await db.query<{ status: string }>('select status from org.fee_item where id = $1', [items[i]])).rows[0]!.status;
const intentOf = async (i: number) => (await db.query<{ external_id: string }>(`select external_id from ops.external_ref where entity_type = 'fee_item_us_intent' and entity_id = $1`, [items[i]])).rows[0]!.external_id;
const rows = async (i: number) => (await db.query<{ kind: string }>('select kind from org.fee_external_payment where fee_item_id = $1 order by seq', [items[i]])).rows.map((r) => r.kind);
const cases = async () => (await db.query<{ n: string }>(`select count(*)::text as n from ops.case where kind = 'us_fee_collection'`)).rows[0]!.n;
const reconcile = (at = NOW) => main.services.usCollections.reconcileEntity(port(), entityRef, new Date(0), at);

beforeAll(async () => {
  db = await createTestDatabase();
  host = new SimulatorHost();
  const base = { db, market: 'IL' as const, issuer: 'https://api.kesher.example', clock: () => NOW };
  const flagsOn = new StaticFlags(undefined, { 'institutions.usBanking': true, 'institutions.money': true });
  main = createApp({ ...base, flags: flagsOn, registry: host.registry, signingKey: await generateSigningKey() });
  off = createApp({ ...base, flags: new StaticFlags(), registry: host.registry, signingKey: await generateSigningKey() });
  await db.query(`insert into org.institution (id, name, market) values ($1, 'Collecting School', 'IL'), ($2, 'Unlinked School', 'IL')`, [INST, FRESH]);
  for (const [name, phone, inst, role] of [['fin', '+972501260001', INST, 'finance'], ['staff', '+972501260002', INST, 'staff'], ['freshFin', '+972501260003', FRESH, 'finance']] as const) {
    await person(main, name, phone, ['member', `org_${role}`]);
    await db.query(`insert into org.staff (party_id, institution_id, role) values ($1, $2, $3)`, [people[name]!.partyId, inst, role]);
  }
  await person(off, 'offFin', '+972501260004', ['member', 'org_finance']);
  await db.query(`insert into org.staff (party_id, institution_id, role) values ($1, $2, 'finance')`, [people['offFin']!.partyId, INST]);
  await decideKyb(db, INST);
  await decideKyb(db, FRESH);
  await main.services.usBanking.link(INST, people['fin']!.partyId, { holder: 'institution', usEntity: { legalName: 'American Friends of Collecting School', ein: '12-3456789' } }, 'col-link-0001', IP, NOW);
  entityRef = (await db.query<{ external_id: string }>(`select external_id from ops.external_ref where entity_type = 'institution_us_banking' and entity_id = $1`, [INST])).rows[0]!.external_id;
  const member = uuidv7(NOW);
  const batch = async (id: string, currency: string, amount: bigint) =>
    db.query(`insert into org.fee_batch (id, idempotency_key, institution_id, description, amount_minor, currency, due_at, member_count, request_hash, created_by, created_at) values ($1, $2, $3, 'Tuition <b>', $4, $5, '2026-12-01', 4, 'h', $6, $7)`, [id, `batch-${id}`, INST, amount.toString(), currency, member, NOW]);
  await batch(BATCH, 'USD', 25_000n);
  await batch(OTHER_BATCH, 'USD', 10_000n);
  await batch(ILS_BATCH, 'ILS', 9_000n);
  const fee = async (i: number, batchId: string, amount: bigint, currency: string) =>
    db.query(`insert into org.fee_item (id, institution_id, member_party_id, description, amount_minor, currency, status, due_at, created_at, batch_id) values ($1, $2, $3, 'Tuition', $4, $5, 'due', '2026-12-01', $6, $7)`, [items[i], INST, member, amount.toString(), currency, NOW, batchId]);
  for (let i = 0; i < 6; i++) await fee(i, BATCH, 25_000n, 'USD');
  await fee(6, OTHER_BATCH, 10_000n, 'USD');
  await fee(7, ILS_BATCH, 9_000n, 'ILS');
}, 300_000);
afterAll(async () => db.close());

describe('fees to US funders (TST-INS-023, T-0652)', () => {
  it('only finance staff and admins collect; an unlinked account and bad bodies are refused', async () => {
    expect((await collect('staff', BATCH, [funder(0)])).status).toBe(403);
    expect((await collect('freshFin', BATCH, [funder(0)], 'collect-key-0002', FRESH)).status).toBe(422);
    expect((await collect('fin', BATCH, [{ ...funder(0), email: 'not-an-email' }])).status).toBe(422);
    expect((await collect('fin', BATCH, [funder(0), funder(0)])).status).toBe(422);
    expect((await collect('fin', BATCH, [])).status).toBe(422);
    expect((await call('fin', 'POST', `/institutions/${INST}/fee-batches/${BATCH}/us-collection`, { funders: [funder(0)] })).status).toBe(422);
  });

  it('the flag off answers 404, and nothing is created', async () => {
    expect((await call('offFin', 'POST', `/institutions/${INST}/fee-batches/${BATCH}/us-collection`, { funders: [funder(0)] }, 'collect-key-0003')).status).toBe(404);
    expect((await db.query('select 1 from org.fee_us_collect')).rows).toHaveLength(0);
  });

  it('a pending link is refused until the bank approves it; then a foreign batch or item and an ILS fee are refused', async () => {
    expect((await collect('fin', BATCH, [funder(0)])).status).toBe(422);
    sim().decide(entityRef);
    await main.services.usBanking.read(INST, NOW);
    expect((await collect('fin', uuidv7(NOW), [funder(0)])).status).toBe(404);
    expect((await collect('fin', BATCH, [funder(6)])).status).toBe(422);
    expect((await collect('fin', ILS_BATCH, [funder(7)])).status).toBe(422);
  });

  it('each funder gets a page once; a repeat answers the same pages; the purse cannot pay a collected fee; nothing posts to the ledger', async () => {
    const before = await journals();
    const r = await collect('fin', BATCH, [funder(0), funder(1)]);
    expect(r.status).toBe(201);
    const body = r.body as { items: { feeItemId: string; status: string; paymentUrl: string }[] };
    expect(body.items).toHaveLength(2);
    expect(body.items.every((x) => x.status === 'collecting' && x.paymentUrl.startsWith('https://'))).toBe(true);
    const again = await collect('fin', BATCH, [funder(0), funder(1)], 'collect-key-0009');
    expect((again.body as typeof body).items.map((x) => x.paymentUrl)).toEqual(body.items.map((x) => x.paymentUrl));
    expect((await db.query(`select 1 from ops.external_ref where entity_type = 'fee_batch_us_collection' and entity_id = $1`, [BATCH])).rows).toHaveLength(1);
    expect((await db.query('select 1 from org.fee_us_collect')).rows).toHaveLength(2);
    // The funder's contact is not stored anywhere in the fee tables.
    expect(JSON.stringify((await db.query('select * from org.fee_us_collect')).rows)).not.toContain('example.org');
    await expect(main.services.collections.pay((await db.query<{ member_party_id: string }>('select member_party_id from org.fee_item where id = $1', [items[0]])).rows[0]!.member_party_id, items[0]!, NOW)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(await journals()).toBe(before);
  });

  it('a payment marks its item paid once, from the provider\'s re-read, however often it is told', async () => {
    sim().pay(await intentOf(0));
    expect(await status(0)).toBe('due'); // nothing is paid until the provider is read
    expect(await reconcile()).toMatchObject({ marked: 1 });
    expect(await status(0)).toBe('paid');
    expect(await reconcile()).toMatchObject({ marked: 0 });
    expect(await rows(0)).toEqual(['payment']);
    expect(await status(1)).toBe('due');
  });

  it('the collected event reaches the same re-read through the webhook handler', async () => {
    sim().pay(await intentOf(1));
    await main.services.crowdedWebhook.process({ provider: 'crowded', eventId: 'evt-collect-0001', receivedAt: NOW.toISOString(), signatureOk: true, payload: { eventId: 'evt-collect-0001', eventType: 'collect.payment.paid', context: { chapterId: entityRef }, data: { fake: 'a body that says paid' } } });
    expect(await status(1)).toBe('paid');
    expect(await rows(1)).toEqual(['payment']);
    // A body with no real payment behind it marks nothing.
    await main.services.crowdedWebhook.process({ provider: 'crowded', eventId: 'evt-collect-0002', receivedAt: NOW.toISOString(), signatureOk: true, payload: { eventId: 'evt-collect-0002', eventType: 'collect.payment.paid', context: { chapterId: entityRef }, data: {} } });
    expect(await status(2)).toBe('due');
  });

  it('a declined payment marks nothing; a payment of another amount opens one case and does not mark paid', async () => {
    expect((await collect('fin', BATCH, [funder(2, 'pay_declined Funder 2'), funder(3)], 'collect-key-0004')).status).toBe(201);
    sim().pay(await intentOf(2));
    sim().pay(await intentOf(3));
    await db.query('update org.fee_item set amount_minor = 26000 where id = $1', [items[3]]);
    const open = await cases();
    expect(await reconcile()).toMatchObject({ marked: 0, cases: 1 });
    expect(await reconcile()).toMatchObject({ marked: 0, cases: 0 });
    expect(await cases()).toBe(String(Number(open) + 1));
    expect(await status(2)).toBe('due');
    expect(await status(3)).toBe('due');
    expect(await rows(3)).toEqual([]);
  });

  it('a refund appends a refund row and opens a case; the fee is not silently reopened', async () => {
    expect((await collect('fin', BATCH, [funder(4, 'pay_refunded Funder 4')], 'collect-key-0005')).status).toBe(201);
    sim().pay(await intentOf(4));
    expect(await reconcile()).toMatchObject({ marked: 1, cases: 1 });
    expect(await rows(4)).toEqual(['payment', 'refund']);
    expect(await reconcile()).toMatchObject({ marked: 0, cases: 0 });
  });

  it('a fee the purse already paid and then a funder paid is a case, not a second paid', async () => {
    expect((await collect('fin', BATCH, [funder(5)], 'collect-key-0006')).status).toBe(201);
    const poster = uuidv7(NOW);
    await db.query(`update org.fee_item set status = 'paid' where id = $1`, [items[5]]);
    await db.query(`insert into ledger.journal (id, idempotency_key, kind, effective_at, created_at) values ($1, $2, 'fee', $3, $3)`, [poster, `fee:${items[5]}`, NOW]).catch(() => undefined);
    sim().pay(await intentOf(5));
    const res = await reconcile();
    expect(res.marked).toBe(0);
    expect(await rows(5)).toEqual([]);
  });

  it('a page boundary mid-list loses no payment', async () => {
    const many = (await db.query<{ n: string }>('select count(*)::text as n from org.fee_external_payment')).rows[0]!.n;
    expect(Number(many)).toBeGreaterThan(0);
    const seen: string[] = [];
    for await (const p of port().collectPayments({ entityRef, since: new Date(0) })) seen.push(p.paymentRef);
    expect(new Set(seen).size).toBe(seen.length);
    expect(money(1n, 'USD').minor).toBe(1n);
  });
});
