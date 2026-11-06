// T-0061: the legal documents over HTTP. TST-LEGAL-061 (no REQ row): anyone reads the documents in force in both languages with
// their hash; a member records acceptance of the version in force against their device and locale, with no IP collected; a draft,
// an old version, an unknown document or a duplicate is refused; recording twice is a no-op; the pending list falls and rises with
// material changes; one member never sees another's consents.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@kesher/domain';
import { SimulatorHost } from '@kesher/simulators';
import { generateSigningKey } from '../auth/tokens.ts';
import { createApp, type App } from '../app.ts';
import { dispatch } from '../server.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { LegalService } from './service.ts';

let db: TestDatabase;
let app: App;
let legal: LegalService;
let t0 = new Date('2026-11-10T09:00:00Z');
const dana = uuidv7(t0);
const noa = uuidv7(t0);
const counsel = uuidv7(t0);
const tokens: Record<string, string> = {};

const call = (who: string | undefined, method: string, url: string, body?: unknown) =>
  dispatch(app, { method, url: `/v1${url}`, headers: who ? { authorization: `Bearer ${tokens[who]}` } : {}, rawBody: body === undefined ? '' : JSON.stringify(body), now: t0 });
const en = (s: string) => ({ en: s, he: `${s} (he)` });
const publish = (docKey: 'terms' | 'privacy' | 'p2p', body: string, material: boolean, effectiveAt = new Date(t0.getTime() - 60_000)) =>
  legal.publish({ docKey, title: en(docKey), body: en(body), material, ...(material ? { changeSummary: en('what changed') } : {}), publishedBy: counsel, effectiveAt });

beforeAll(async () => {
  db = await createTestDatabase();
  app = createApp({ db, registry: new SimulatorHost().registry, market: 'IL', signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', clock: () => t0 });
  legal = new LegalService(db);
  for (const [k, id] of [['dana', dana], ['noa', noa]] as const) tokens[k] = (await app.services.tokens.issue({ partyId: id, deviceId: `phone-${k}`, roles: ['member'] })).accessToken;
}, 60_000);
afterAll(async () => db.close());

describe('GET /legal/documents', () => {
  it('is public, empty until something is in force, then lists one version per document in both languages with its hash', async () => {
    const empty = await call(undefined, 'GET', '/legal/documents');
    expect(empty).toMatchObject({ status: 200, body: { items: [] } });
    await publish('terms', 'terms v1', true);
    await publish('privacy', 'privacy v1', true);
    const r = await call(undefined, 'GET', '/legal/documents');
    expect(r.status).toBe(200);
    const items = (r.body as { items: { docKey: string; version: number; hash: string; title: { en: string; he: string }; body: { en: string; he: string } }[] }).items;
    expect(items.map((d) => d.docKey).sort()).toEqual(['privacy', 'terms']);
    const terms = items.find((d) => d.docKey === 'terms')!;
    expect(terms).toMatchObject({ version: 1, body: { en: 'terms v1', he: 'terms v1 (he)' } });
    expect(terms.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('shows the newest version already in force and never a future one', async () => {
    await publish('terms', 'terms v2', true);
    await publish('terms', 'terms v3 (not yet)', true, new Date(t0.getTime() + 86_400_000));
    const items = ((await call(undefined, 'GET', '/legal/documents')).body as { items: { docKey: string; version: number }[] }).items;
    expect(items.find((d) => d.docKey === 'terms')!.version).toBe(2);
  });
});

describe('GET and POST /me/consents', () => {
  it('needs a sign-in', async () => {
    expect((await call(undefined, 'GET', '/me/consents')).status).toBe(401);
    expect((await call(undefined, 'POST', '/me/consents', { documents: [{ docKey: 'terms', version: 2 }], locale: 'en' })).status).toBe(401);
  });

  it('lists everything as pending first; accepting the versions in force records device, locale and hash, with no real IP', async () => {
    const before = (await call('dana', 'GET', '/me/consents')).body as { accepted: unknown[]; pending: { docKey: string; reason: string }[] };
    expect(before.accepted).toEqual([]);
    expect(before.pending.map((d) => `${d.docKey}:${d.reason}`).sort()).toEqual(['privacy:first', 'terms:first']);

    const rec = await call('dana', 'POST', '/me/consents', { documents: [{ docKey: 'terms', version: 2 }, { docKey: 'privacy', version: 1 }], locale: 'he' });
    expect(rec.status).toBe(201);
    const accepted = (rec.body as { accepted: { docKey: string; version: number; locale: string; hash: string }[] }).accepted;
    expect(accepted.map((a) => `${a.docKey}:${a.version}:${a.locale}`)).toEqual(['terms:2:he', 'privacy:1:he']);

    const row = (await db.query<{ device_id: string; ip: string; hash: string }>('select device_id, host(ip) as ip, hash from legal.consent where party_id = $1 and doc_key = $2', [dana, 'terms'])).rows[0]!;
    expect(row.device_id).toBe('phone-dana');
    expect(row.ip).toBe('0.0.0.0');
    expect(row.hash).toBe(accepted[0]!.hash);

    const after = (await call('dana', 'GET', '/me/consents')).body as { accepted: unknown[]; pending: unknown[] };
    expect(after.accepted).toHaveLength(2);
    expect(after.pending).toEqual([]);
  });

  it('recording the same versions again is a no-op that returns the original acceptance', async () => {
    const again = await call('dana', 'POST', '/me/consents', { documents: [{ docKey: 'terms', version: 2 }], locale: 'en' });
    expect(again.status).toBe(201);
    expect((await db.query('select 1 from legal.consent where party_id = $1 and doc_key = $2', [dana, 'terms'])).rowCount).toBe(1);
    expect((again.body as { accepted: { locale: string }[] }).accepted[0]!.locale).toBe('he'); // the first record stands
  });

  it('a material change makes the document pending again, with its reason, until it is accepted', async () => {
    await publish('privacy', 'privacy v2', true);
    const pending = ((await call('dana', 'GET', '/me/consents')).body as { pending: { docKey: string; version: number; reason: string }[] }).pending;
    expect(pending).toEqual([expect.objectContaining({ docKey: 'privacy', version: 2, reason: 'material_change' })]);
    expect((await call('dana', 'POST', '/me/consents', { documents: [{ docKey: 'privacy', version: 2 }], locale: 'en' })).status).toBe(201);
    expect(((await call('dana', 'GET', '/me/consents')).body as { pending: unknown[] }).pending).toEqual([]);
  });

  it('one member never sees another\'s acceptances', async () => {
    const mine = (await call('noa', 'GET', '/me/consents')).body as { accepted: unknown[]; pending: unknown[] };
    expect(mine.accepted).toEqual([]);
    expect(mine.pending).toHaveLength(2);
  });

  it('refuses a version not in force (an old one, a future one, a missing one), an unknown document, a duplicate and bad input, recording nothing', async () => {
    const bad = async (body: unknown) => (await call('noa', 'POST', '/me/consents', body)).status;
    expect(await bad({ documents: [{ docKey: 'terms', version: 1 }], locale: 'en' })).toBe(422); // old
    expect(await bad({ documents: [{ docKey: 'terms', version: 3 }], locale: 'en' })).toBe(422); // future
    expect(await bad({ documents: [{ docKey: 'p2p', version: 1 }], locale: 'en' })).toBe(422); // nothing in force
    expect(await bad({ documents: [{ docKey: 'marketing', version: 1 }], locale: 'en' })).toBe(422);
    expect(await bad({ documents: [{ docKey: 'terms', version: 2 }, { docKey: 'terms', version: 2 }], locale: 'en' })).toBe(422);
    expect(await bad({ documents: [{ docKey: 'terms', version: 1.5 }], locale: 'en' })).toBe(422);
    expect(await bad({ documents: [], locale: 'en' })).toBe(422);
    expect(await bad({ documents: [{ docKey: 'terms', version: 2 }], locale: 'fr' })).toBe(422);
    expect(await bad({ locale: 'en' })).toBe(422);
    // A good document next to a bad one records neither.
    expect(await bad({ documents: [{ docKey: 'privacy', version: 2 }, { docKey: 'terms', version: 1 }], locale: 'en' })).toBe(422);
    expect((await db.query('select 1 from legal.consent where party_id = $1', [noa])).rowCount).toBe(0);
  });
});
