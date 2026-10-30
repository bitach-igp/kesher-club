// T-0530 who a payment goes to (TST-PAY-001, recipient rows): a known phone resolves to "Avi E." and says he can
// receive; a member id resolves the same way; an unknown phone and a closed account answer the same 404 with no
// hint; a member who set no name resolves with none; malformed input answers 422; the 31st lookup in a minute
// answers RATE_LIMITED, and the next minute opens again; with the flag off it answers FEATURE_OFF.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@kesher/domain';
import { SimulatorHost } from '@kesher/simulators';
import { generateSigningKey } from '../auth/tokens.ts';
import { StaticFlags } from '../billing/capabilities.ts';
import { createApp, type App } from '../app.ts';
import { dispatch } from '../server.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { LOOKUPS_PER_MINUTE } from './recipients.ts';

let db: TestDatabase;
let app: App;
let off: App;
const NOW = new Date('2026-11-10T09:00:00Z');
const AVI = { id: uuidv7(NOW), phone: '+15555550102' };
const NONAME = { id: uuidv7(NOW), phone: '+15555550111' };
const GONE = { id: uuidv7(NOW), phone: '+15555550112' };
const tokens: Record<string, string> = {};

const resolve = (who: string, body: unknown, now = NOW, a: App = app) => dispatch(a, { method: 'POST', url: '/v1/p2p/recipients/resolve', headers: { authorization: `Bearer ${tokens[who]}` }, rawBody: JSON.stringify(body), now });

async function member(m: { id: string; phone: string }, status: 'active' | 'closed' = 'active', t1 = true) {
  await app.services.identity.createUser({ partyId: m.id, phone: m.phone, status, roles: ['member'], createdAt: NOW.toISOString() });
  if (t1) await db.query(`insert into identity.kyc_session (session_id, party_id, tier, market, provider, status, started_at, expires_at, decided_at) values ($1, $2, 'T1', 'US', 'simulator', 'approved', $3, $3::timestamptz + interval '1 day', $3)`, [`kyc-${m.id}`, m.id, NOW]);
}

beforeAll(async () => {
  db = await createTestDatabase();
  const opts = { db, registry: new SimulatorHost().registry, market: 'US' as const, signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', clock: () => NOW };
  app = createApp({ ...opts, flags: new StaticFlags(undefined, { 'p2p.enabled': true }) });
  off = createApp({ ...opts, identity: app.services.identity, flags: new StaticFlags(undefined, { 'p2p.enabled': false }) });
  await member(AVI);
  await member(NONAME, 'active', false);
  await member(GONE, 'closed');
  await app.services.displayNames.set(AVI.id, { firstName: 'Avi', lastName: 'Example' }, NOW);
  for (const who of ['dana', 'probe']) tokens[who] = (await app.services.tokens.issue({ partyId: uuidv7(NOW), deviceId: `phone-${who}`, roles: ['member'] })).accessToken;
}, 60_000);
afterAll(async () => db.close());

describe('TST-PAY-001: resolving a recipient (T-0530)', () => {
  it('a known phone resolves to "Avi E." who can receive; his member id resolves the same; spaces and dashes in the phone are fine', async () => {
    const byPhone = await resolve('dana', { phone: '+1 555-555-0102' });
    expect(byPhone).toMatchObject({ status: 200, body: { partyId: AVI.id, displayName: 'Avi E.', canReceive: true } });
    expect(Object.keys(byPhone.body as object).sort()).toEqual(['canReceive', 'displayName', 'partyId']);
    expect((await resolve('dana', { memberId: AVI.id })).body).toEqual(byPhone.body);
  });

  it('a member with no name and no T1 resolves with neither; an unknown phone and a closed account answer the same 404', async () => {
    expect((await resolve('dana', { phone: NONAME.phone })).body).toEqual({ partyId: NONAME.id, canReceive: false });
    const unknown = await resolve('dana', { phone: '+15555550199' });
    const closed = await resolve('dana', { phone: GONE.phone });
    expect(unknown).toMatchObject({ status: 404, body: { code: 'NOT_FOUND' } });
    expect((closed.body as { detail?: string }).detail).toBe((unknown.body as { detail?: string }).detail);
    expect(closed.status).toBe(404);
  });

  it('refuses malformed input: both, neither, a local number, a non-id', async () => {
    for (const body of [{ phone: AVI.phone, memberId: AVI.id }, {}, { phone: '0501234567' }, { memberId: 'db411990' }]) {
      expect((await resolve('dana', body)).status).toBe(422);
    }
  });

  it('the 31st lookup in a minute answers RATE_LIMITED; a minute later it opens again', async () => {
    for (let i = 0; i < LOOKUPS_PER_MINUTE; i++) expect((await resolve('probe', { phone: `+1555555${String(1000 + i)}` })).status).toBe(404);
    expect(await resolve('probe', { phone: AVI.phone })).toMatchObject({ status: 429, body: { code: 'RATE_LIMITED' } });
    expect((await resolve('probe', { phone: AVI.phone }, new Date(NOW.getTime() + 61_000))).status).toBe(200);
  });

  it('with p2p off it answers FEATURE_OFF and says nothing about the number', async () => {
    expect((await resolve('dana', { phone: AVI.phone }, NOW, off)).body).toMatchObject({ code: 'FEATURE_OFF' });
  });
});
