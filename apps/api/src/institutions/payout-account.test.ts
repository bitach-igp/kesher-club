// T-0623 own-name payout accounts (TST-INS-012, REQ-INS-012), over HTTP and the payout service:
// - an account is refused before the register's name is known, and for a holder who is not the institution;
// - it waits for a second compliance member, never the recorder;
// - a ₪3,000.00 payout to a different IBAN is refused and opens one compliance case;
// - a payout to the verified IBAN goes;
// - a replacement stops payouts until it is approved.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { DomainError, uuidv7 } from '@kesher/domain';
import { SimulatorHost } from '@kesher/simulators';
import { STAFF_AUDIENCE, STAFF_ISSUER } from '../admin/staff-token.ts';
import { generateSigningKey } from '../auth/tokens.ts';
import { StaticFlags } from '../billing/capabilities.ts';
import { createApp, type App } from '../app.ts';
import { dispatch } from '../server.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { decideKyb } from '../test-institution.ts';
import { sameHolder, type PayoutAccount } from './payout-account.ts';

let db: TestDatabase;
let app: App;
let privateKey: CryptoKey;
const NOW = new Date('2026-11-10T09:00:00Z');
const FINANCE = uuidv7(NOW);
const OWN = 'IL620108000000099999999';
const OTHER = 'IL070108000000012345678';
const CLEO = { sub: 'compliance-cleo', roles: ['compliance'] };
const CARL = { sub: 'compliance-carl', roles: ['compliance'] };

const token = (who: { sub: string; roles: string[] }) =>
  new SignJWT({ roles: who.roles }).setProtectedHeader({ alg: 'ES256', kid: 'admin-1' }).setIssuer(STAFF_ISSUER).setAudience(STAFF_AUDIENCE).setSubject(who.sub).setIssuedAt(Math.floor(NOW.getTime() / 1000)).setExpirationTime(Math.floor(NOW.getTime() / 1000) + 300).sign(privateKey);
const call = async (who: { sub: string; roles: string[] }, method: string, url: string, body?: unknown, key?: string) =>
  dispatch(app, { method, url, headers: { authorization: `Bearer ${await token(who)}`, ...(key ? { 'idempotency-key': key } : {}) }, rawBody: body === undefined ? '' : JSON.stringify(body), now: NOW });
const record = (inst: string, iban: string, holderName: string, key: string) => call(CLEO, 'POST', `/v1/admin/institutions/${inst}/payout-accounts`, { iban, holderName, evidenceRef: `kyb-file/${inst}/bank-letter.pdf` }, key);
const payout = (inst: string, iban: string, minor: string, key: string) =>
  app.services.payouts.request(inst, { payee: { iban, name: 'Yeshivat Example' }, amount: { minor, currency: 'ILS' }, reference: 'transfer to own account' }, key, NOW, { kind: 'institution', requestedBy: FINANCE, requesterRole: 'finance' });
const refusal = async (p: Promise<unknown>): Promise<DomainError> => {
  const e = await p.then(() => undefined, (x: unknown) => x);
  expect(e).toBeInstanceOf(DomainError);
  return e as DomainError;
};
const cases = async (inst: string) => (await db.query<{ n: number }>(`select count(*)::int as n from ops.case where kind = 'payout_account_mismatch' and payload->>'institutionId' = $1`, [inst])).rows[0]!.n;

/** An approved, funded amuta whose identifier check found it on the register as "Yeshivat Example (ע"ר)". */
async function institution(): Promise<string> {
  const id = uuidv7();
  await db.query(`insert into org.institution (id, name, market) values ($1, 'Yeshivat Example', 'IL')`, [id]);
  await decideKyb(db, id);
  await app.services.institutionKyb.recordCheck(id, { kind: 'identifier', result: 'clear', provider: 'simulator', evidenceRef: 'sim-registry', detail: { identifier: '580123456', registeredName: 'Yeshivat Example (ע"ר)' } }, undefined, NOW);
  const s = app.services;
  await s.ledger.post({ idempotencyKey: `fund:${id}:settle`, kind: 'deposit', effectiveAt: NOW, postings: [{ accountId: await s.accounts.systemAccount('partner_settlement', 'ILS'), currency: 'ILS', amountMinor: 1_000_000n }, { accountId: await s.accounts.institutionAccount(id, 'ILS'), currency: 'ILS', amountMinor: -1_000_000n }], metadata: { institutionId: id } });
  return id;
}

beforeAll(async () => {
  db = await createTestDatabase();
  const pair = await generateKeyPair('ES256');
  privateKey = pair.privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'admin-1', alg: 'ES256', use: 'sig' };
  app = createApp({ db, registry: new SimulatorHost().registry, market: 'IL', signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', staffJwks: [jwk], clock: () => NOW, flags: new StaticFlags(undefined, { 'payouts.nium': true }) });
}, 60_000);
afterAll(async () => db.close());

describe('own-name payout accounts (T-0623, TST-INS-012)', () => {
  it('the holder must be the registered name, punctuation, case and legal forms aside', () => {
    expect(sameHolder('YESHIVAT EXAMPLE', 'Yeshivat Example (ע"ר)')).toBe(true);
    expect(sameHolder('Yeshivat  Example ע״ר', 'Yeshivat Example')).toBe(true);
    expect(sameHolder('Day School Example, Inc.', 'Day School Example')).toBe(true);
    expect(sameHolder('Building Supplies Ltd', 'Yeshivat Example')).toBe(false);
    expect(sameHolder('', '')).toBe(false);
  });

  it('is refused before the register\'s name is known, and for another holder; it waits for a second compliance member', async () => {
    const bare = uuidv7();
    await db.query(`insert into org.institution (id, name, market) values ($1, 'No Check Yet', 'IL')`, [bare]);
    expect((await record(bare, OWN, 'No Check Yet', 'acct-bare')).body).toMatchObject({ code: 'VALIDATION_FAILED', reason: 'no_registered_name' });
    const inst = await institution();
    expect((await record(inst, OTHER, 'Building Supplies Ltd', `acct-${inst}-wrong`)).body).toMatchObject({ code: 'VALIDATION_FAILED', reason: 'holder_not_registered_name' });
    expect((await record(inst, OWN, 'YESHIVAT EXAMPLE', `acct-${inst}-nokey`)).status).toBe(201);
    expect((await call({ sub: 'sam', roles: ['support'] }, 'POST', `/v1/admin/institutions/${inst}/payout-accounts`, { iban: OWN, holderName: 'Yeshivat Example', evidenceRef: 'x' }, `acct-${inst}-sam`)).status).toBe(403);
    const accounts = ((await call(CLEO, 'GET', `/v1/admin/institutions/${inst}/payout-accounts`)).body as { items: PayoutAccount[] }).items;
    expect(accounts[0]).toMatchObject({ status: 'pending', ibanMasked: expect.stringContaining('9999'), holderName: 'YESHIVAT EXAMPLE' });
    expect(JSON.stringify(accounts)).not.toContain(OWN);
    expect((await refusal(payout(inst, OWN, '300000', `po-${inst}-early`))).extra).toMatchObject({ reason: 'account_pending_approval' });
    expect((await call(CLEO, 'POST', `/v1/admin/payout-accounts/${accounts[0]!.id}/approve`)).status).toBe(409);
    expect((await call(CARL, 'POST', `/v1/admin/payout-accounts/${accounts[0]!.id}/approve`)).body).toMatchObject({ status: 'active' });
  });

  it('a ₪3,000.00 payout to a different IBAN is refused and opens one compliance case; a payout to the verified IBAN goes', async () => {
    const inst = await institution();
    const acct = (await record(inst, OWN, 'Yeshivat Example', `acct-${inst}`)).body as PayoutAccount;
    await call(CARL, 'POST', `/v1/admin/payout-accounts/${acct.id}/approve`);
    expect((await refusal(payout(inst, OTHER, '300000', `po-${inst}-other`))).extra).toMatchObject({ reason: 'not_own_account' });
    await refusal(payout(inst, OTHER, '300000', `po-${inst}-other`));
    expect(await cases(inst)).toBe(1);
    expect((await payout(inst, OWN, '300000', `po-${inst}-own`)).state).not.toBe('failed');
  });

  it('a replacement stops payouts until a second compliance member approves it; the old account is superseded', async () => {
    const inst = await institution();
    const first = (await record(inst, OWN, 'Yeshivat Example', `acct-${inst}-1`)).body as PayoutAccount;
    await call(CARL, 'POST', `/v1/admin/payout-accounts/${first.id}/approve`);
    const next = (await record(inst, OTHER, 'Yeshivat Example', `acct-${inst}-2`)).body as PayoutAccount;
    expect((await refusal(payout(inst, OWN, '10000', `po-${inst}-a`))).extra).toMatchObject({ reason: 'account_pending_approval' });
    await call(CARL, 'POST', `/v1/admin/payout-accounts/${next.id}/approve`);
    const items = ((await call(CLEO, 'GET', `/v1/admin/institutions/${inst}/payout-accounts`)).body as { items: PayoutAccount[] }).items;
    expect(items.map((a) => a.status)).toEqual(['active', 'superseded']);
    expect((await refusal(payout(inst, OWN, '10000', `po-${inst}-b`))).extra).toMatchObject({ reason: 'not_own_account' });
    expect((await payout(inst, OTHER, '10000', `po-${inst}-c`)).state).not.toBe('failed');
    // The audit names who recorded and who approved each account.
    expect((await app.services.audit.list(inst, 20)).map((e) => e.action).filter((a) => a.startsWith('institution.payout_account'))).toEqual(expect.arrayContaining(['institution.payout_account.record', 'institution.payout_account.approve']));
  });
});
