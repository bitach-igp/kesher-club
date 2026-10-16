// T-0304: legal CMS. Versioned documents (terms, privacy, insurance disclosures, cardholder
// agreement), consent records per party, and a re-accept requirement when a material version
// is published. Consent is evidence: who, which version, when, from which device; never updated.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@kesher/domain';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { LegalService } from './service.ts';

let db: TestDatabase;
let legal: LegalService;
const t0 = new Date('2026-11-01T10:00:00Z');

beforeAll(async () => {
  db = await createTestDatabase();
  legal = new LegalService(db);
}, 60_000);
afterAll(async () => db.close());

describe('LegalService', () => {
  it('publishes immutable versions with en/he bodies and a hash; the current version is the latest published', async () => {
    const v1 = await legal.publish({ docKey: 'terms', title: { en: 'Terms of Service', he: 'תנאי שימוש' }, body: { en: 'v1 terms', he: 'v1 תנאים' }, material: true, publishedBy: uuidv7(), effectiveAt: t0 });
    expect(v1.version).toBe(1);
    expect(v1.hash).toMatch(/^[a-f0-9]{64}$/);
    const v2 = await legal.publish({ docKey: 'terms', title: { en: 'Terms of Service', he: 'תנאי שימוש' }, body: { en: 'v2 terms: typo fixed', he: 'v2' }, material: false, publishedBy: uuidv7(), effectiveAt: new Date(t0.getTime() + 1000) });
    expect(v2.version).toBe(2);
    expect((await legal.current('terms', new Date(t0.getTime() + 2000))).version).toBe(2);
    await db.asRole('club_app', async (app) => expect(app.query(`update legal.document_version set body_en = 'x'`)).rejects.toMatchObject({ code: '42501' }));
  });

  it('records consent once per party and version, with the evidence the bank needs', async () => {
    const party = uuidv7();
    const c = await legal.accept({ partyId: party, docKey: 'terms', version: 2, deviceId: 'iphone-1', ip: '203.0.113.9', locale: 'he' }, t0);
    expect(c).toMatchObject({ partyId: party, docKey: 'terms', version: 2, hash: expect.any(String), locale: 'he' });
    const again = await legal.accept({ partyId: party, docKey: 'terms', version: 2, deviceId: 'iphone-1', ip: '203.0.113.9', locale: 'he' }, new Date(t0.getTime() + 5000));
    expect(again.acceptedAt).toBe(c.acceptedAt);
    await expect(legal.accept({ partyId: party, docKey: 'terms', version: 99, deviceId: 'd', ip: '1.1.1.1', locale: 'en' }, t0)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('re-accept is required only when a material version is published after the last consent', async () => {
    const party = uuidv7();
    await legal.publish({ docKey: 'privacy', title: { en: 'Privacy', he: 'פרטיות' }, body: { en: 'p1', he: 'p1' }, material: true, publishedBy: uuidv7(), effectiveAt: t0 });
    const at = new Date(t0.getTime() + 2000); // terms v2 is in force from t0 + 1 s
    expect(await legal.pending(party, at)).toEqual([expect.objectContaining({ docKey: 'privacy', version: 1, reason: 'first' }), expect.objectContaining({ docKey: 'terms', version: 2, reason: 'first' })]);
    await legal.accept({ partyId: party, docKey: 'privacy', version: 1, deviceId: 'd', ip: '1.1.1.1', locale: 'en' }, at);
    await legal.accept({ partyId: party, docKey: 'terms', version: 2, deviceId: 'd', ip: '1.1.1.1', locale: 'en' }, at);
    expect(await legal.pending(party, at)).toEqual([]);
    // Non-material edit: no re-accept.
    const t1 = new Date(t0.getTime() + 60_000);
    await legal.publish({ docKey: 'privacy', title: { en: 'Privacy', he: 'פרטיות' }, body: { en: 'p1 typo', he: 'p1' }, material: false, publishedBy: uuidv7(), effectiveAt: t1 });
    expect(await legal.pending(party, new Date(t1.getTime() + 1))).toEqual([]);
    // Material change: re-accept sheet shows this document only, with a diff summary for the sheet.
    const t2 = new Date(t0.getTime() + 120_000);
    await legal.publish({ docKey: 'privacy', title: { en: 'Privacy', he: 'פרטיות' }, body: { en: 'p3 new data sharing', he: 'p3' }, material: true, changeSummary: { en: 'We now share data with the eSIM partner.', he: 'שיתוף נתונים עם ספק ה-eSIM.' }, publishedBy: uuidv7(), effectiveAt: t2 });
    const pending = await legal.pending(party, new Date(t2.getTime() + 1));
    expect(pending).toEqual([expect.objectContaining({ docKey: 'privacy', version: 3, changeSummary: expect.objectContaining({ en: expect.stringContaining('eSIM') }) })]);
  });

  it('a document that has an effective date in the future is not yet current or pending', async () => {
    const party = uuidv7();
    await legal.publish({ docKey: 'cardholder', title: { en: 'Cardholder Agreement', he: 'הסכם' }, body: { en: 'c1', he: 'c1' }, material: true, publishedBy: uuidv7(), effectiveAt: new Date('2027-01-01T00:00:00Z') });
    await expect(legal.current('cardholder', t0)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await legal.pending(party, t0)).map((p) => p.docKey)).not.toContain('cardholder');
    expect((await legal.pending(party, new Date('2027-01-02T00:00:00Z'))).map((p) => p.docKey)).toContain('cardholder');
  });

  it('exports the consent evidence for a party in audit order', async () => {
    const party = uuidv7();
    await legal.accept({ partyId: party, docKey: 'terms', version: 1, deviceId: 'd', ip: '1.1.1.1', locale: 'en' }, t0);
    await legal.accept({ partyId: party, docKey: 'terms', version: 2, deviceId: 'd', ip: '1.1.1.1', locale: 'en' }, new Date(t0.getTime() + 1));
    const history = await legal.consents(party);
    expect(history.map((h) => h.version)).toEqual([1, 2]);
  });
});
