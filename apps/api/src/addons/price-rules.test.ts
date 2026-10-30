// TST-MKT-002 rules from the admin API (T-0928): Kesher finance proposes an add-on price rule and a second finance
// member activates it; until then it prices nothing. Support cannot propose; the proposer cannot approve; a bad
// pattern, margin, floor, kind or missing reason answers 422; a rejected rule never activates. Once active, the
// rule prices the eSIM vendor's plans the way the catalogue sync reads it.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { money, type Currency } from '@kesher/domain';
import { SimulatorHost } from '@kesher/simulators';
import { STAFF_AUDIENCE, STAFF_ISSUER } from '../admin/staff-token.ts';
import { generateSigningKey } from '../auth/tokens.ts';
import { createApp, type App } from '../app.ts';
import { dispatch } from '../server.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { priceFor, type PriceRule } from './pricing.ts';
import type { PriceRuleView } from './price-rules.ts';

let db: TestDatabase;
let app: App;
let privateKey: CryptoKey;
const NOW = new Date('2026-11-10T09:00:00Z');
const A = { sub: 'finance-a', roles: ['finance'] };
const B = { sub: 'finance-b', roles: ['finance'] };
const SUPPORT = { sub: 'support-1', roles: ['support'] };

const token = (sub: string, roles: string[]) =>
  new SignJWT({ roles }).setProtectedHeader({ alg: 'ES256', kid: 'admin-1' }).setIssuer(STAFF_ISSUER).setAudience(STAFF_AUDIENCE).setSubject(sub).setIssuedAt(Math.floor(NOW.getTime() / 1000)).setExpirationTime(Math.floor(NOW.getTime() / 1000) + 300).sign(privateKey);
const call = async (who: { sub: string; roles: string[] }, method: string, url: string, body?: unknown) =>
  dispatch(app, { method, url: `/v1${url}`, headers: { authorization: `Bearer ${await token(who.sub, who.roles)}` }, rawBody: body === undefined ? '' : JSON.stringify(body), now: NOW });
const esimRule = (over: Record<string, unknown> = {}) => ({ kind: 'esim', provider: 'simulator', skuPattern: '^IL-', marginBps: 2500, floor: { minor: '0', currency: 'USD' }, roundTo99: true, priority: 10, reason: 'Launch margin for Israel eSIMs', ...over });

/** The rules as the catalogue sync reads them (apps/worker/src/catalogue/sync.ts): active only. */
async function activeRules(): Promise<PriceRule[]> {
  const r = await db.query<{ id: string; kind: PriceRule['kind']; provider: string; sku_pattern: string; margin_bps: number; floor_minor: string; currency: Currency; round_to_99: boolean; priority: number }>('select * from addons.price_rule where active order by priority');
  return r.rows.map((x) => ({ id: x.id, kind: x.kind, provider: x.provider, skuPattern: new RegExp(x.sku_pattern), marginBps: BigInt(x.margin_bps), floor: money(BigInt(x.floor_minor), x.currency), roundTo99: x.round_to_99, priority: x.priority }));
}

beforeAll(async () => {
  db = await createTestDatabase();
  const pair = await generateKeyPair('ES256');
  privateKey = pair.privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'admin-1', alg: 'ES256', use: 'sig' };
  app = createApp({ db, registry: new SimulatorHost().registry, market: 'IL', signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', staffJwks: [jwk], clock: () => NOW });
}, 60_000);
afterAll(async () => db.close());

describe('add-on price rules (TST-MKT-002, T-0928)', () => {
  let proposed: PriceRuleView;

  it('support cannot propose; finance proposes, and the rule is inactive and prices nothing', async () => {
    expect((await call(SUPPORT, 'POST', '/admin/price-rules', esimRule())).status).toBe(403);
    const r = await call(A, 'POST', '/admin/price-rules', esimRule());
    expect(r.status).toBe(201);
    proposed = r.body as PriceRuleView;
    expect(r.body).toMatchObject({ kind: 'esim', provider: 'simulator', skuPattern: '^IL-', marginBps: 2500, state: 'proposed', proposedBy: 'finance-a', approval: { status: 'awaiting_second_approval', approvals: 1 } });
    expect(await activeRules()).toEqual([]);
    expect(priceFor(await activeRules(), 'esim', 'simulator', 'IL-5GB-30D', money(950n, 'USD'))).toBeUndefined();
  });

  it('the proposer cannot approve; a second finance member activates it, audited, and it prices the vendor\'s plans', async () => {
    const self = await call(A, 'POST', `/admin/price-rules/${proposed.id}/approve`);
    expect(self.status).toBe(409);
    const r = await call(B, 'POST', `/admin/price-rules/${proposed.id}/approve`);
    expect(r.body).toMatchObject({ state: 'active', activatedAt: NOW.toISOString(), approval: { status: 'approved' } });
    const audit = await db.query<{ action: string }>(`select action from audit.entry where action = 'price_rule.activate'`);
    expect(audit.rows).toHaveLength(1);
    // $9.50 cost + 25% is $11.875, $11.88 in cents; rounded up to .99 it is $11.99.
    expect(priceFor(await activeRules(), 'esim', 'simulator', 'IL-5GB-30D', money(950n, 'USD'))?.price.minor).toBe(1199n);
    expect(priceFor(await activeRules(), 'esim', 'simulator', 'US-5GB', money(950n, 'USD'))).toBeUndefined();
    expect((await call(B, 'POST', `/admin/price-rules/${proposed.id}/approve`)).status).toBe(409);
    expect(((await call(SUPPORT, 'GET', '/admin/price-rules')).body as { items: PriceRuleView[] }).items.map((i) => i.state)).toEqual(['active']);
  });

  it('a bad pattern, margin, floor, kind or provider, or no reason, answers 422 and writes nothing', async () => {
    for (const bad of [{ skuPattern: '(' }, { marginBps: 20_001 }, { marginBps: 12.5 }, { floor: { minor: '-1', currency: 'USD' } }, { floor: { minor: '100', currency: 'EUR' } }, { kind: 'flights' }, { provider: 'Sim Provider' }, { reason: ' ' }, { priority: 0 }]) {
      expect((await call(A, 'POST', '/admin/price-rules', esimRule(bad))).status, JSON.stringify(bad)).toBe(422);
    }
    expect((await db.query('select 1 from addons.price_rule')).rows).toHaveLength(1);
  });

  it('a rejected rule never activates, and a decided rule takes no more decisions', async () => {
    const r = (await call(A, 'POST', '/admin/price-rules', esimRule({ marginBps: 9000, reason: 'Too high, on purpose' }))).body as PriceRuleView;
    expect((await call(B, 'POST', `/admin/price-rules/${r.id}/reject`, {})).status).toBe(422);
    expect((await call(B, 'POST', `/admin/price-rules/${r.id}/reject`, { reason: 'Margin above policy' })).body).toMatchObject({ state: 'rejected' });
    expect((await call(B, 'POST', `/admin/price-rules/${r.id}/approve`)).status).toBe(409);
    expect((await activeRules()).map((x) => x.id)).toEqual([proposed.id]);
    expect((await call(B, 'POST', '/admin/price-rules/not-a-rule/approve')).status).toBe(404);
  });
});
