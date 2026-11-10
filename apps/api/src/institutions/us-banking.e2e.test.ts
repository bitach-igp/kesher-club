// TST-INS-022 TST-INS-023 TST-INS-024 TST-INS-025 US banking end to end against Crowded over HTTP (T-0660). The API runs with PROVIDER_INSTITUTION_BANKING=crowded
// and talks to the Crowded HTTP simulator on a random port (the panel server, FakeCrowded behind /crowded/api/v1); the simulator signs and POSTs its
// webhook batches to the API's own HTTP server on another random port, where the receiver at /webhooks/crowded verifies the raw bytes. The script that
// registers the receiver is the real tools/crowded-webhooks.mjs, run with --simulator. Nothing is posted by an event: the worker's replay re-reads the
// provider and hands its CURRENT state to the card that owns the object, so a delivery in any order leaves the state the re-read returned.
//   1. link: a platform institution (sub-account) and an institution on its own entity; the bank approves, the event arrives, and money opens only after our KYB
//   2. fee: a US fee is billed, paid on the simulator, and the batch delivered twice marks it paid once
//   3. fund: the master account by ACH, the request linked to the deposit; a returned ACH opens a case
//   4. a delivery with a wrong signature is refused and logged in ops.inbound_rejected, then retried
// ORDER MATTERS: the four describes run top to bottom in this file and share one database, one simulator and one API server. Flow 1 links the
// institutions (OHR's link and KYB), flow 2 bills and pays fees on OHR, flow 3 funds OHR, flow 4 reuses OHR's link. Each `it` also leans on the one
// before it in its own block. So run the file whole: `-t` on a single test fails by design. (describe.sequential says so to the runner.)
import { execFile } from 'node:child_process';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CROWDED_SIGNATURE_HEADER, FakeCrowded } from '@kesher/adapters';
import { money, uuidv7 } from '@kesher/domain';
import { SIM_OTP_CODE, SimPasskeyDevice, fixedClock, type AdvanceableClock, type InstitutionBankingPort } from '@kesher/ports';
import { SimulatorHost, createServer as createPanel } from '@kesher/simulators';
import { CrowdedHttpSimulator } from '@kesher/simulators/crowded-http';
import { createApp, type App } from '../app.ts';
import { generateSigningKey } from '../auth/tokens.ts';
import { StaticFlags } from '../billing/capabilities.ts';
import { loadApiConfig } from '../config.ts';
import type { SqlClient } from '../db.ts';
import { createRegistry, crowdedWebhookSecrets, overridesFromConfig } from '../registry.ts';
import { createServer as createApiServer, dispatch } from '../server.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { decideKyb } from '../test-institution.ts';
import { CROWDED_PROVIDER } from '../webhooks/crowded.ts';
import { paymentReference } from './deposits.ts';

const NOW = new Date('2026-11-03T09:00:00Z');
const LATER = new Date('2026-11-03T09:30:00Z');
const IP = '198.51.100.4';
const TOKEN = 'e2e-crowded-token-0001';
const SECRET = 'e2e-webhook-secret-0123456789-abcdef';
const BASE_PATH = '/crowded/api/v1';
/** The adapter and the config insist on https; the fetch below sends it to the simulator on loopback. */
const SIM_ORIGIN = 'https://crowded.sim.invalid';
const TOOL = fileURLToPath(new URL('../../../../tools/crowded-webhooks.mjs', import.meta.url));
const pexec = promisify(execFile);

const OHR = uuidv7(NOW);
const PLAT = uuidv7(NOW);
const BETH = uuidv7(NOW);
const BATCH = uuidv7(NOW);
const items: string[] = Array.from({ length: 4 }, () => uuidv7(NOW));

let db: TestDatabase;
let app: App;
let fake: FakeCrowded;
let crowded: CrowdedHttpSimulator;
let panel: http.Server;
let apiServer: http.Server;
let panelOrigin = '';
let apiOrigin = '';
let platformRef = '';
let registry: ReturnType<typeof createRegistry>['registry'];

type Who = { partyId: string; access: string; stepUp: string };
const people: Record<string, Who> = {};
const usd = (minor: bigint) => ({ minor: minor.toString(), currency: 'USD' });
const listen = (server: http.Server): Promise<number> => new Promise((resolve) => server.listen(0, () => resolve((server.address() as AddressInfo).port)));
const close = (server: http.Server): Promise<void> => new Promise((resolve) => server.close(() => resolve()));

const call = (who: string, method: string, url: string, body?: unknown, opts: { key?: string; stepUp?: boolean } = {}) =>
  dispatch(app, {
    method,
    url: `/v1${url}`,
    headers: { authorization: `Bearer ${people[who]!.access}`, ...(opts.key ? { 'idempotency-key': opts.key } : {}), ...(opts.stepUp === false ? {} : { 'x-step-up': people[who]!.stepUp }), 'x-forwarded-for': `203.0.113.99, ${IP}` },
    rawBody: body === undefined ? '' : JSON.stringify(body),
    now: NOW,
  });
const link = (who: string, inst: string, body: unknown, key: string) => call(who, 'POST', `/institutions/${inst}/us-banking`, body, { key });
const status = (who: string, inst: string) => call(who, 'GET', `/institutions/${inst}/us-banking`);
const quote = (who: string, inst: string, minor: bigint) => call(who, 'POST', `/institutions/${inst}/us-funding/quote`, { amount: usd(minor) }, { stepUp: false });
const request = (who: string, inst: string, quoteId: string, key: string) => call(who, 'POST', `/institutions/${inst}/us-funding`, { quoteId }, { key });
const approve = (who: string, inst: string, id: string) => call(who, 'POST', `/institutions/${inst}/us-funding/${id}/approve`);
type Funding = { id: string; status: string; reference: string; achStatus?: string; depositId?: string; amount: { minor: string } };
const funding = async (who: string, inst: string, id: string) => ((await call(who, 'GET', `/institutions/${inst}/us-funding`)).body as { items: Funding[] }).items.find((x) => x.id === id)!;
/** A funding request that the second finance user approved: the ACH is out and the bank holds it as pending. */
async function sent(minor: bigint, key: string): Promise<{ view: Funding; paymentRef: string }> {
  const q = (await quote('ohrFin1', OHR, minor)).body as { quoteId: string };
  const asked = await request('ohrFin1', OHR, q.quoteId, key);
  expect(asked.status).toBe(201);
  const approved = await approve('ohrFin2', OHR, (asked.body as Funding).id);
  expect(approved.body).toMatchObject({ status: 'in_transit', achStatus: 'pending' });
  const paymentRef = (await db.query<{ external_id: string }>(`select external_id from ops.external_ref where entity_type = 'institution_us_funding' and entity_id = $1`, [(asked.body as Funding).id])).rows[0]!.external_id;
  return { view: approved.body as Funding, paymentRef };
}

const refOf = async (inst: string) => (await db.query<{ external_id: string }>(`select external_id from ops.external_ref where entity_type = 'institution_us_banking' and entity_id = $1`, [inst])).rows[0]!.external_id;
const bankingRows = async (inst: string) => (await db.query<{ status: string }>('select status from org.institution_us_banking_event where institution_id = $1 order by seq', [inst])).rows.map((r) => r.status);
const stored = async () => (await db.query<{ event_id: string; signature_ok: boolean; processed_at: string | null; payload: { eventType: string; data?: { id?: string } } }>(`select event_id, signature_ok, processed_at, payload from ops.inbound_event where provider = 'crowded' order by received_at, event_id`)).rows;
const rejected = async () => (await db.query<{ event_id: string; payload: { reason: string; sha256: string } }>(`select event_id, payload from ops.inbound_rejected where provider = 'crowded' order by received_at, id`)).rows;
const replay = () => app.services.webhooks.replay({ provider: CROWDED_PROVIDER, now: NOW });
const feeStatus = async (i: number) => (await db.query<{ status: string }>('select status from org.fee_item where id = $1', [items[i]])).rows[0]!.status;
const feePayments = async (i: number) => (await db.query<{ kind: string }>('select kind from org.fee_external_payment where fee_item_id = $1 order by seq', [items[i]])).rows.map((r) => r.kind);
const fundingKinds = async (id: string) => (await db.query<{ kind: string }>('select kind from org.us_funding_event where request_id = $1 order by seq', [id])).rows.map((r) => r.kind);
const cases = async (reason: string) => (await db.query<{ n: string }>(`select count(*)::text as n from ops.case where kind = 'us_funding_failed' and payload->>'reason' = $1`, [reason])).rows[0]!.n;

async function person(name: string, phone: string, roles: string[], inst: string, role: 'admin' | 'finance'): Promise<void> {
  const s = app.services;
  const started = await s.otp.start({ phone, locale: 'he' });
  const verified = await s.otp.verify({ otpId: started.otpId, code: SIM_OTP_CODE, purpose: 'register' });
  const device = new SimPasskeyDevice();
  const r1 = await s.passkeys.register({ otpSessionToken: verified.otpSessionToken!, deviceId: `web-${phone}`, deviceName: 'Console' });
  const r2 = await s.passkeys.register({ otpSessionToken: verified.otpSessionToken!, deviceId: `web-${phone}`, deviceName: 'Console', response: await device.register(r1.options!) });
  const partyId = (await s.tokens.verifyAccess(r2.tokens!.accessToken)).partyId;
  const access = (await s.tokens.issue({ partyId, deviceId: `web-${phone}`, roles })).accessToken;
  const principal = await s.tokens.verifyAccess(access);
  const su = await s.stepUp.start(principal);
  people[name] = { partyId, access, stepUp: (await s.stepUp.complete(principal, await device.authenticate(su.options))).stepUpToken };
  await db.query(`insert into org.staff (party_id, institution_id, role) values ($1, $2, $3)`, [partyId, inst, role]);
}

const env = {
  APP_ENV: 'preview',
  DATABASE_URL: 'postgres://club_app@db.internal:5432/club',
  TEMPORAL_ADDRESS: 'temporal.internal:7233',
  PROVIDER_MODE_DEFAULT: 'sim',
  JWT_SIGNING_KEY: '{"kty":"EC","crv":"P-256","x":"x","y":"y","d":"d"}',
  JWT_SIGNING_KID: 'k-e2e',
  TOKEN_ISSUER: 'https://api.kesher.example',
  MARKET: 'IL',
  STAFF_JWKS: '{"keys":[{"kty":"EC","crv":"P-256","x":"x","y":"y","kid":"staff-1"}]}',
  PORT: '8080',
  PII_DATA_KEY: Buffer.alloc(32, 7).toString('base64'),
  PII_INDEX_KEY: Buffer.alloc(32, 9).toString('base64'),
};

beforeAll(async () => {
  const raw = await createTestDatabase();
  // PGlite has one connection, held by an open transaction: a Postgres key ledger querying the base instance from inside
  // link()'s transaction would wait on it forever. So every query through this wrapper goes to the transaction that is
  // currently open, if any: the adapter's PostgresVendorKeyLedger (T-0659) then joins the caller's transaction instead of
  // deadlocking, and real transactions (lock table and all) still run. Production Postgres has a pool and needs none of this.
  let currentTx: SqlClient | undefined;
  const query: SqlClient['query'] = (text, params) => (currentTx ?? raw).query(text, params);
  db = {
    query,
    transaction: (fn) =>
      raw.transaction(async (tx) => {
        const prev = currentTx;
        currentTx = tx;
        try {
          return await fn(tx);
        } finally {
          currentTx = prev;
        }
      }),
    asRole: raw.asRole,
    close: raw.close,
  };
  fake = new FakeCrowded({ token: TOKEN, pageSize: 2, now: () => NOW }); // a provider page of two, so every list crosses page boundaries
  crowded = new CrowdedHttpSimulator({ backend: fake, token: TOKEN });
  panel = createPanel(new SimulatorHost(), { crowded });
  panelOrigin = `http://localhost:${await listen(panel)}`;
  const toSimulator: typeof globalThis.fetch = (input, init) => fetch(String(input).replace(SIM_ORIGIN, panelOrigin), init);

  // The API's configuration, as a deployment would set it: the banking port on Crowded, an https base URL, the token and the endpoint secret.
  const config = loadApiConfig({ ...env, PROVIDER_INSTITUTION_BANKING: 'crowded', CROWDED_BASE_URL: `${SIM_ORIGIN}${BASE_PATH}`, CROWDED_API_TOKEN: TOKEN, CROWDED_WEBHOOK_SECRETS: SECRET });
  // T-0659's wiring end to end: the override straight from the config, with the Postgres key ledger it builds, pointed at
  // the HTTP simulator. The adapter options the config has no key for yet (T-0659 "Not done") ride on the override.
  const created = createRegistry('sim', fixedClock('2026-11-03T09:00:00Z') as AdvanceableClock, {
    institutionBanking: {
      ...overridesFromConfig(config, db).institutionBanking!,
      fetch: toSimulator,
      subAccountEmail: 'ops@kesher.example',
      collectionCounterpartyRef: 'cp_kesher',
      payer: { ip: '198.51.100.7', consented: true },
    },
  });
  registry = created.registry;
  expect(created.providers).toEqual({ 'institution-banking': 'crowded', esim: 'sim', insurance: 'sim', 'org-idp': 'sim', 'federated-idp': 'sim', funding: 'sim', 'notify-sms': 'sim', 'notify-email': 'sim', 'notify-push': 'sim' });
  expect(registry.bindingFor('institution-banking', 'IL')).toMatchObject({ provider: CROWDED_PROVIDER });

  // The platform's own entity is created through that config-built adapter, and the simulator approves it over HTTP.
  const banking = registry.resolve<InstitutionBankingPort>('institution-banking', 'IL');
  platformRef = (await banking.createEntity({ holder: 'platform', institutionId: uuidv7(NOW), legalName: 'Israel Global Pay, LLC', ein: '98-7654321', idempotencyKey: 'platform-setup-0001' })).entityRef;
  await crowded.decide(platformRef); // no receiver registered yet: nothing is delivered
  expect(await banking.applicationStatus(platformRef)).toBe('approved');

  const flags = new StaticFlags(undefined, { 'institutions.usBanking': true, 'institutions.deposits': true, 'institutions.bankFeed': true, 'institutions.money': true });
  app = createApp({
    db,
    market: 'IL',
    issuer: 'https://api.kesher.example',
    clock: () => NOW,
    flags,
    registry,
    signingKey: await generateSigningKey(),
    crowdedWebhookSecrets: crowdedWebhookSecrets(config),
    usBankingPlatformEntityRef: platformRef,
    usCollectionCounterpartyRef: 'cp_kesher',
  });
  apiServer = createApiServer(app);
  apiOrigin = `http://localhost:${await listen(apiServer)}`;

  await db.query(`insert into org.institution (id, name, market) values ($1, 'Yeshivat Ohr', 'IL'), ($2, 'Platform School', 'IL'), ($3, 'Beth Friends', 'IL')`, [OHR, PLAT, BETH]);
  await person('ohrAdmin', '+972501270001', ['member', 'org_admin'], OHR, 'admin');
  await person('ohrFin1', '+972501270002', ['member', 'org_finance'], OHR, 'finance');
  await person('ohrFin2', '+972501270003', ['member', 'org_finance'], OHR, 'finance');
  await person('platAdmin', '+972501270004', ['member', 'org_admin'], PLAT, 'admin');
  await person('bethAdmin', '+972501270005', ['member', 'org_admin'], BETH, 'admin');
  await decideKyb(db, PLAT);
  await decideKyb(db, BETH);
  // Four USD fees in one batch, for the fee flow.
  const member = uuidv7(NOW);
  await db.query(`insert into org.fee_batch (id, idempotency_key, institution_id, description, amount_minor, currency, due_at, member_count, request_hash, created_by, created_at) values ($1, 'batch-e2e-0001', $2, 'Tuition', 25000, 'USD', '2026-12-01', 4, 'h', $3, $4)`, [BATCH, OHR, member, NOW]);
  for (const id of items) await db.query(`insert into org.fee_item (id, institution_id, member_party_id, description, amount_minor, currency, status, due_at, created_at, batch_id) values ($1, $2, $3, 'Tuition', 25000, 'USD', 'due', '2026-12-01', $4, $5)`, [id, OHR, member, NOW, BATCH]);

  // The registration is the real script, against the simulator, pointing Crowded at the API's own HTTP server.
  const registered = await pexec(process.execPath, [TOOL, 'create', '--url', `${apiOrigin}/webhooks/crowded`, '--simulator'], {
    env: { ...process.env, CROWDED_BASE_URL: `${panelOrigin}${BASE_PATH}`, CROWDED_API_TOKEN: TOKEN, CROWDED_WEBHOOK_SECRET: SECRET },
  });
  expect(JSON.parse(registered.stdout)).toMatchObject({ status: 201 });
  expect(registered.stdout).not.toContain(SECRET);
}, 300_000);

afterAll(async () => {
  await close(panel);
  await close(apiServer);
  await db.close();
});

// A failed assertion must not leave the simulator holding batches for the tests after it.
afterEach(() => {
  crowded.outOfOrder = false;
});

describe.sequential('1. link: the bank approves, the event arrives, money opens only after our KYB (REQ-INS-022)', { timeout: 60_000 }, () => {
  it('the registration the script made is on the simulator, and the API is reachable at the URL it holds', async () => {
    const listed = await fetch(`${panelOrigin}${BASE_PATH}/webhooks`, { headers: { authorization: `Bearer ${TOKEN}` } });
    const body = (await listed.json()) as { data: { url: string; isActive: boolean; secret?: string }[] };
    expect(body.data).toMatchObject([{ url: `${apiOrigin}/webhooks/crowded`, isActive: true }]);
    expect(body.data[0]!.secret).toBeUndefined();
  });

  it('a platform institution is a sub-account at Crowded, approved with its own account; the number never leaves', async () => {
    const r = await link('platAdmin', PLAT, { holder: 'platform' }, 'plat-link-0001');
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toEqual({ status: 'approved', holder: 'platform', sharesPlatformAccount: false });
    expect(fake.count('chapters')).toBe(2); // the platform's own and the sub-account
    const read = await status('platAdmin', PLAT);
    expect(read.body).toMatchObject({ status: 'approved', holder: 'platform', sharesPlatformAccount: false, moneyOpen: true, last4: expect.stringMatching(/^\d{4}$/) });
    expect(JSON.stringify(read.body)).not.toContain(fake.accountNumber(await refOf(PLAT)));
    expect(fake.calls.some((c) => c.method === 'POST' && c.path === `/chapters/${platformRef}/subaccounts`)).toBe(true);
    expect(await bankingRows(PLAT)).toEqual(['approved']);
  });

  it('an institution on its own entity: pending at first, with the hosted form; the simulator approves and the webhook arrives', async () => {
    const r = await link('ohrAdmin', OHR, { holder: 'institution', usEntity: { legalName: 'American Friends of Yeshivat Ohr', ein: '12-3456789' } }, 'ohr-link-0001');
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: 'pending', holder: 'institution', formUrl: expect.stringMatching(/^https:\/\//) });
    const ref = await refOf(OHR);
    expect(await bankingRows(OHR)).toEqual(['pending']);

    const out = await crowded.decide(ref);
    expect(out.delivered).toMatchObject([{ status: 200, delivered: true }]);
    // Stored with a good signature, and nothing more: the receiver only stores, the status follows the worker's replay.
    const events = await stored();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ signature_ok: true, processed_at: null, payload: { eventType: 'finance.application.approved' } });
    expect(await bankingRows(OHR)).toEqual(['pending']);

    expect(await replay()).toEqual({ attempted: 1, succeeded: 1 });
    expect(await bankingRows(OHR)).toEqual(['pending', 'approved']);
    expect(await replay()).toEqual({ attempted: 0, succeeded: 0 });
  });

  it('approved by the bank is not open money: it needs our KYB too', async () => {
    const before = (await status('ohrFin1', OHR)).body as { status: string; moneyOpen: boolean; last4: string };
    expect(before).toMatchObject({ status: 'approved', moneyOpen: false, last4: expect.stringMatching(/^\d{4}$/) });
    const refused = await quote('ohrFin1', OHR, 100_000n);
    expect(refused.status).toBe(404);
    expect(JSON.stringify(refused.body)).toContain('FEATURE_OFF');
    expect((await call('ohrFin1', 'POST', `/institutions/${OHR}/fee-batches/${BATCH}/us-collection`, { funders: [{ feeItemId: items[0], name: 'Dana Levi', email: 'dana@example.org', mobile: '+14155550100' }] }, { key: 'collect-early-0001', stepUp: false })).status).toBe(404);
    expect(fake.count('collections')).toBe(0);

    await decideKyb(db, OHR);
    expect(((await status('ohrFin1', OHR)).body as { moneyOpen: boolean }).moneyOpen).toBe(true);
    expect(await bankingRows(OHR)).toEqual(['pending', 'approved']);
  });

  it('events in any order leave the state the re-read returned: submitted after approved changes nothing', async () => {
    expect((await link('bethAdmin', BETH, { holder: 'institution', usEntity: { legalName: 'Beth Friends Inc.', ein: '45-1234567' } }, 'beth-link-0001')).status).toBe(201);
    const ref = await refOf(BETH);
    const before = (await stored()).length;
    crowded.outOfOrder = true; // batches are held until they are told to go
    const submitted = await crowded.emit([{ eventType: 'finance.application.submitted', chapterId: ref, data: { chapterId: ref, status: 'submitted' } }]); // older, and says "submitted"
    const approved = await crowded.decide(ref); // newer: the bank approves
    expect(await stored()).toHaveLength(before);

    // The newer event reaches the receiver first, and the worker re-reads: approved.
    expect(await crowded.redeliver(approved.batchIds[0]!)).toMatchObject([{ status: 200, delivered: true }]);
    expect(await replay()).toMatchObject({ attempted: 1, succeeded: 1 });
    expect(await bankingRows(BETH)).toEqual(['pending', 'approved']);
    // The older one arrives after it. What it says ("submitted") is not applied: the re-read still returns approved.
    expect(await crowded.redeliver(submitted.batchIds[0]!)).toMatchObject([{ status: 200, delivered: true }]);
    crowded.outOfOrder = false;
    expect((await stored()).slice(before).map((e) => e.payload.eventType).sort()).toEqual(['finance.application.approved', 'finance.application.submitted']);
    expect(await replay()).toMatchObject({ attempted: 1, succeeded: 1 });
    expect(await bankingRows(BETH)).toEqual(['pending', 'approved']);
    expect(((await status('bethAdmin', BETH)).body as { status: string }).status).toBe('approved');
  });
});

describe.sequential('2. fee: billed in the US, paid on the simulator, delivered twice, paid once (REQ-INS-023)', { timeout: 60_000 }, () => {
  const funder = (i: number) => ({ feeItemId: items[i], name: `Funder ${i}`, email: `funder${i}@example.org`, mobile: `+1415555010${i}` });
  const intentOf = async (i: number) => (await db.query<{ external_id: string }>(`select external_id from ops.external_ref where entity_type = 'fee_item_us_intent' and entity_id = $1`, [items[i]])).rows[0]!.external_id;

  it('each funder gets a payment page from Crowded, once', async () => {
    const r = await call('ohrFin1', 'POST', `/institutions/${OHR}/fee-batches/${BATCH}/us-collection`, { funders: [funder(0), funder(1)] }, { key: 'collect-key-0001', stepUp: false });
    expect(r.status).toBe(201);
    const body = r.body as { items: { status: string; paymentUrl: string }[] };
    expect(body.items.map((x) => x.status)).toEqual(['collecting', 'collecting']);
    expect(body.items.every((x) => x.paymentUrl.startsWith('https://'))).toBe(true);
    const again = await call('ohrFin1', 'POST', `/institutions/${OHR}/fee-batches/${BATCH}/us-collection`, { funders: [funder(0), funder(1)] }, { key: 'collect-key-0002', stepUp: false });
    expect((again.body as typeof body).items.map((x) => x.paymentUrl)).toEqual(body.items.map((x) => x.paymentUrl));
    expect(fake.count('collections')).toBe(1);
  });

  it('the funder pays on the simulator: the webhook batch marks the fee paid once, whether it is delivered once or twice', async () => {
    const out = await crowded.pay(await intentOf(0));
    expect(out.delivered).toMatchObject([{ status: 200, delivered: true }]);
    expect(await feeStatus(0)).toBe('due'); // a body that says succeeded pays nothing until the provider is read
    expect(await replay()).toMatchObject({ attempted: 1, succeeded: 1 });
    expect(await feeStatus(0)).toBe('paid');
    expect(await feePayments(0)).toEqual(['payment']);

    // The same batch again, byte for byte: the receiver has it already.
    const batchId = out.delivered[0]!.batchId;
    const twice = await crowded.redeliver(batchId);
    expect(twice).toMatchObject([{ status: 200, delivered: true }]);
    expect(JSON.parse(twice[0]!.response ?? '{}')).toMatchObject({ received: 1, stored: 0, duplicates: 1 });
    expect(await replay()).toEqual({ attempted: 0, succeeded: 0 });
    // And a fresh event (another id) naming the same payment re-reads it: still one payment on the item.
    const paymentId = (await stored()).find((e) => e.payload.eventType === 'collect.payment.succeeded')?.payload.data?.id;
    expect(paymentId).toEqual(expect.stringMatching(/^cp\d+$/));
    await crowded.emit([{ eventType: 'collect.payment.succeeded', chapterId: await refOf(OHR), data: { id: paymentId! } }]);
    expect(await replay()).toMatchObject({ attempted: 1, succeeded: 1 });
    expect(await feePayments(0)).toEqual(['payment']);
    expect(await feeStatus(1)).toBe('due');
  });

  it('only a fee the funder paid is marked: the second funder, delivered twice, is marked once; the others stay due', async () => {
    const out = await crowded.pay(await intentOf(1));
    expect(out.delivered).toMatchObject([{ status: 200 }]);
    expect(await replay()).toMatchObject({ attempted: 1, succeeded: 1 });
    const again = await crowded.redeliver(out.delivered[0]!.batchId);
    expect(again).toMatchObject([{ status: 200, delivered: true }]);
    expect(JSON.parse(again[0]!.response ?? '{}')).toMatchObject({ received: 1, stored: 0, duplicates: 1 });
    expect(await replay()).toEqual({ attempted: 0, succeeded: 0 });
    expect(await feeStatus(1)).toBe('paid');
    expect(await feePayments(1)).toEqual(['payment']);
    expect(await feeStatus(2)).toBe('due');
  });
});

describe.sequential('3. fund: the master account by ACH, linked to the deposit; a returned ACH opens a case (REQ-INS-024)', { timeout: 60_000 }, () => {
  it('a quote prices the ACH, a second approver sends it with the KC- reference, and the simulator moves it on', async () => {
    fake.fund(await refOf(OHR), 10_000_000n);
    const q = await quote('ohrFin1', OHR, 200_000n);
    expect(q.status).toBe(200);
    expect(q.body).toMatchObject({ amount: usd(200_000n), fee: usd(25n), holder: 'institution' });

    const { view, paymentRef } = await sent(200_000n, 'fund-key-0001');
    const ohrRef = await refOf(OHR);
    const originated = fake.calls.filter((c) => c.method === 'POST' && c.path === `/chapters/${ohrRef}/payments`).at(-1)!;
    expect((originated.body as { data: { payments: { counterpartyId: string; addenda: string }[] } }).data.payments[0]).toMatchObject({ counterpartyId: 'cp_kesher', addenda: paymentReference(OHR) });
    expect(view.reference).toBe(paymentReference(OHR));

    const moved = await crowded.settleAch(paymentRef);
    expect(moved.delivered).toMatchObject([{ status: 200 }, { status: 200 }]);
    expect(await replay()).toMatchObject({ attempted: 2, succeeded: 2 });
    expect(await funding('ohrFin1', OHR, view.id)).toMatchObject({ status: 'in_transit', achStatus: 'sent' });
    // Nothing is posted by the bank moving it on.
    expect(await app.services.accounts.institutionBalance(OHR, 'USD')).toEqual(money(0n, 'USD'));

    // The money arrives with the KC- reference and the deposit path posts it: the request is linked to the deposit.
    const credit = { creditId: 'bcr-e2e-1', rail: 'ach' as const, amount: money(200_000n, 'USD'), bankReference: 'FT2611-E2E1', remitterReference: `ACH CREDIT ${view.reference}`, valueDate: '2026-11-03' };
    expect(await app.services.deposits.applyBankCredit(credit, 'bank', LATER)).toMatchObject({ kind: 'posted' });
    expect(await funding('ohrFin1', OHR, view.id)).toMatchObject({ status: 'received', depositId: expect.any(String) });
    expect(await app.services.accounts.institutionBalance(OHR, 'USD')).toEqual(money(200_000n, 'USD'));
  });

  it('a returned ACH is what the bank says when it is read: the request shows it and one case opens, however often it is told', async () => {
    const { view, paymentRef } = await sent(210_000n, 'fund-key-0002');
    // The bank sends it first: only a sent ACH can come back.
    const moved = await crowded.settleAch(paymentRef);
    expect(moved.delivered).toMatchObject([{ status: 200 }, { status: 200 }]);
    expect(await replay()).toMatchObject({ attempted: 2, succeeded: 2 });
    expect(await funding('ohrFin1', OHR, view.id)).toMatchObject({ status: 'in_transit', achStatus: 'sent' });
    expect(await cases('returned')).toBe('0');
    const out = await crowded.returnAch(paymentRef);
    expect(out.delivered).toMatchObject([{ status: 200 }]);
    expect(await replay()).toMatchObject({ attempted: 1, succeeded: 1 });
    expect(await funding('ohrFin1', OHR, view.id)).toMatchObject({ status: 'returned', achStatus: 'returned' });
    expect(await cases('returned')).toBe('1');
    const again = await crowded.redeliver(out.delivered[0]!.batchId);
    expect(again).toMatchObject([{ status: 200, delivered: true }]);
    expect(JSON.parse(again[0]!.response ?? '{}')).toMatchObject({ stored: 0, duplicates: 1 });
    const told = await crowded.emit([{ eventType: 'finance.ach_payment.returned', chapterId: await refOf(OHR), data: { id: paymentRef.split(':')[1]! } }]);
    expect(told.delivered).toMatchObject([{ status: 200 }]);
    expect(await replay()).toMatchObject({ attempted: 1, succeeded: 1 });
    expect(await cases('returned')).toBe('1');
    expect(await funding('ohrFin1', OHR, view.id)).toMatchObject({ status: 'returned' });
  });

  it('delivered newest first, the ACH steps leave the state the re-read returned: sent, recorded once', async () => {
    const { view, paymentRef } = await sent(220_000n, 'fund-key-0003');
    crowded.outOfOrder = true;
    const held = await crowded.settleAch(paymentRef);
    expect(held.batchIds).toHaveLength(2);
    expect(await replay()).toEqual({ attempted: 0, succeeded: 0 }); // nothing has been delivered yet
    const flushed = await crowded.flush();
    crowded.outOfOrder = false;
    // The receiver heard `sent` before `processing` (the batches were queued processing first).
    expect(flushed.map((d) => d.batchId)).toEqual([...held.batchIds].reverse());
    expect(flushed.every((d) => d.status === 200)).toBe(true);
    expect(await replay()).toMatchObject({ attempted: 2, succeeded: 2 });
    expect(await funding('ohrFin1', OHR, view.id)).toMatchObject({ status: 'in_transit', achStatus: 'sent' });
    expect((await fundingKinds(view.id)).filter((k) => k === 'ach_status')).toHaveLength(1);

    // And a stale step arriving after the replay changes nothing: a new `processing` event, read again as `sent`.
    const stale = await crowded.emit([{ eventType: 'finance.ach_payment.processing', chapterId: await refOf(OHR), data: { id: paymentRef.split(':')[1]!, status: 'processing' } }]);
    expect(stale.delivered).toMatchObject([{ status: 200, delivered: true }]);
    expect(await replay()).toMatchObject({ attempted: 1, succeeded: 1 });
    expect(await funding('ohrFin1', OHR, view.id)).toMatchObject({ status: 'in_transit', achStatus: 'sent' });
    expect((await fundingKinds(view.id)).filter((k) => k === 'ach_status')).toHaveLength(1);
  });
});

describe.sequential('4. a wrong signature is refused and logged (REQ-INS-025)', { timeout: 60_000 }, () => {
  it('a delivery signed with another key answers 401, lands in ops.inbound_rejected as a hash and claims nothing; the retry with the right key is stored', async () => {
    const ref = await refOf(OHR);
    const before = { stored: (await stored()).length, rejected: (await rejected()).length };
    crowded.badSignature = true;
    const out = await crowded.emit([{ eventType: 'finance.application.approved', chapterId: ref }]);
    expect(out.delivered).toMatchObject([{ status: 401, delivered: false }]);
    expect(await stored()).toHaveLength(before.stored);
    const rows = await rejected();
    expect(rows).toHaveLength(before.rejected + 1);
    expect(rows.at(-1)).toMatchObject({ payload: { reason: 'MISMATCH', sha256: expect.stringMatching(/^[0-9a-f]{64}$/) } });
    expect(JSON.stringify(rows.at(-1)!.payload)).not.toContain('finance.application');
    expect(await replay()).toEqual({ attempted: 0, succeeded: 0 });

    // At least once: the simulator keeps it and tries again, now signed with the secret the script registered.
    crowded.badSignature = false;
    const retry = await crowded.flush();
    expect(retry).toMatchObject([{ status: 200, delivered: true, attempt: 2 }]);
    expect(await stored()).toHaveLength(before.stored + 1);
    expect(await rejected()).toHaveLength(before.rejected + 1);
  });

  it('a delivery with no signature, or a malformed one, is refused the same way', async () => {
    const before = (await rejected()).length;
    const body = JSON.stringify({ batchId: 'b-forged', count: 1, events: [{ eventId: 'ev-forged', eventType: 'finance.application.approved', context: { chapterId: await refOf(OHR) }, data: {} }] });
    for (const headers of [{}, { [CROWDED_SIGNATURE_HEADER]: 'sha256=not-hex' }]) {
      const res = await fetch(`${apiOrigin}/webhooks/crowded`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
      expect(res.status).toBe(401);
    }
    expect((await rejected()).length).toBe(before + 2);
    expect((await stored()).some((e) => e.event_id === 'ev-forged')).toBe(false);
  });
});
