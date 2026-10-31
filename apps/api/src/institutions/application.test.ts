// TST-INS-016 self-serve institution applications (T-0632, REQ-INS-016): Rivka, signed in with no institution,
// applies for Yeshivat Ohr (IL), adds herself as a signatory, proposes the yeshiva's own account and submits. The
// ops queue holds a kyb_application case; Rivka is Ohr's admin; Ohr's deposits stay shut by the KYB gate.
// Submitting without a signatory or the account answers 422; a second application 409; staff of an institution
// 409; the flag off, FEATURE_OFF. A reviewer's "needs more info" reopens the draft with the reasons, and a
// resubmit returns it to the queue.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@kesher/domain';
import { SimulatorHost } from '@kesher/simulators';
import { generateSigningKey } from '../auth/tokens.ts';
import { StaticFlags } from '../billing/capabilities.ts';
import { createApp, type App } from '../app.ts';
import { dispatch } from '../server.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { abaOk, parseAccount, type InstitutionApplication } from './application.ts';

let db: TestDatabase;
let app: App;
let off: App;
const NOW = new Date('2026-11-10T09:00:00Z');
const later = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
const OWN_IBAN = 'IL620108000000099999999';
const people: Record<string, { partyId: string; token: string }> = {};
const OHR = { legalName: 'Yeshivat Ohr (ע"ר)', market: 'IL', registrationNumber: '580123456', address: { line1: '12 HaRav Kook', city: 'Jerusalem', postalCode: '9422712' } };

const call = (who: string, method: string, url: string, body?: unknown, key?: string, a: App = app, now = NOW) =>
  dispatch(a, { method, url: `/v1${url}`, headers: { authorization: `Bearer ${people[who]!.token}`, ...(key ? { 'idempotency-key': key } : {}) }, rawBody: body === undefined ? '' : JSON.stringify(body), now });
const kybCases = async () => (await db.query<{ status: string; payload: Record<string, unknown> }>(`select status, payload from ops.case where kind = 'kyb_application' order by opened_at`)).rows;
const asApp = (r: { body?: unknown }) => r.body as InstitutionApplication;

beforeAll(async () => {
  db = await createTestDatabase();
  const opts = { db, registry: new SimulatorHost().registry, market: 'IL' as const, signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', clock: () => NOW };
  app = createApp({ ...opts, flags: new StaticFlags(undefined, { 'institutions.selfServe': true }) });
  off = createApp({ ...opts, identity: app.services.identity, flags: new StaticFlags(undefined, { 'institutions.selfServe': false }) });
  for (const [i, who] of ['rivka', 'dov', 'staffer'].entries()) {
    const partyId = uuidv7(NOW);
    await app.services.identity.createUser({ partyId, phone: `+97250222000${i}`, status: 'active', roles: ['member'], createdAt: NOW.toISOString() });
    people[who] = { partyId, token: (await app.services.tokens.issue({ partyId, deviceId: 'phone', roles: ['member'] })).accessToken };
  }
  // The staffer is already staff of another institution.
  const other = uuidv7(NOW);
  await db.query(`insert into org.institution (id, name, market) values ($1, 'Other School', 'IL')`, [other]);
  await db.query(`insert into org.staff (party_id, institution_id, role) values ($1, $2, 'staff')`, [people['staffer']!.partyId, other]);
}, 60_000);
afterAll(async () => db.close());

describe('self-serve institution applications (TST-INS-016, T-0632)', () => {
  let id: string;
  let inst: string;

  it('Rivka applies for Ohr: a draft, and she is its admin', async () => {
    const r = await call('rivka', 'POST', '/institution-applications', OHR, 'ohr-apply-1');
    expect(r.status).toBe(201);
    const a = asApp(r);
    ({ id, institutionId: inst } = a);
    expect(a).toMatchObject({ legalName: OHR.legalName, market: 'IL', status: 'draft', editable: true, signatories: [] });
    // A retry is the same application.
    expect(asApp(await call('rivka', 'POST', '/institution-applications', OHR, 'ohr-apply-1')).id).toBe(id);
    const staff = await db.query<{ institution_id: string; role: string }>('select institution_id, role from org.staff where party_id = $1 and active', [people['rivka']!.partyId]);
    expect(staff.rows).toEqual([{ institution_id: inst, role: 'admin' }]);
    expect((await app.services.identity.findUser(people['rivka']!.partyId))?.roles).toEqual(['member', 'org_admin']);
    expect(asApp(await call('rivka', 'GET', '/me/institution-application')).id).toBe(id);
  });

  it('submitting needs a signatory and the account; the account must be in the organisation\'s name', async () => {
    const empty = await call('rivka', 'POST', `/institution-applications/${id}/submit`);
    expect([empty.status, (empty.body as { missing: string[] }).missing]).toEqual([422, ['signatory', 'account']]);
    const added = asApp(await call('rivka', 'POST', `/institution-applications/${id}/signatories`, { fullName: 'Rivka Levi', roles: ['signatory', 'control'], self: true }, 'ohr-person-1'));
    expect(added.signatories).toEqual([expect.objectContaining({ fullName: 'Rivka Levi', self: true })]);
    const notOurs = await call('rivka', 'POST', `/institution-applications/${id}/account`, { holderName: 'Rivka Levi', iban: OWN_IBAN });
    expect([notOurs.status, (notOurs.body as { problems: string[] }).problems]).toEqual([422, ['HOLDER_NOT_ORGANISATION']]);
    const acct = asApp(await call('rivka', 'POST', `/institution-applications/${id}/account`, { holderName: 'YESHIVAT OHR', iban: OWN_IBAN }));
    expect(acct.account).toEqual({ currency: 'ILS', holderName: 'YESHIVAT OHR', masked: 'IL62 •••• 9999' });
    expect(JSON.stringify(acct)).not.toContain('0108000000099999999');
  });

  it('submits into the ops queue; money stays shut until a KYB decision', async () => {
    const s = asApp(await call('rivka', 'POST', `/institution-applications/${id}/submit`, undefined, undefined, app, later(1)));
    expect(s).toMatchObject({ status: 'submitted', editable: false, submittedAt: later(1).toISOString() });
    // Submitting again answers it unchanged, and no change is accepted while it is with compliance.
    expect(asApp(await call('rivka', 'POST', `/institution-applications/${id}/submit`, undefined, undefined, app, later(2))).submittedAt).toBe(later(1).toISOString());
    expect((await call('rivka', 'POST', `/institution-applications/${id}/signatories`, { fullName: 'Avi Cohen', roles: ['board'] }, 'ohr-person-2')).status).toBe(409);
    expect(await kybCases()).toEqual([{ status: 'open', payload: expect.objectContaining({ institutionId: inst, applicationId: id, summary: 'Self-serve application: Yeshivat Ohr (ע"ר) (IL)' }) }]);
    await expect(app.services.kybGate.require(inst, 'deposits')).rejects.toMatchObject({ code: 'FEATURE_OFF' });
  });

  it("a reviewer's needs-more-info reopens the draft with the reasons; a resubmit returns it to the queue", async () => {
    await app.services.institutionKyb.decide(inst, { status: 'needs_more_info', reasons: ['The bank letter is not legible'] }, 'ohr-kyb-1', { partyId: uuidv7(NOW), role: 'compliance' }, later(3));
    const back = asApp(await call('rivka', 'GET', '/me/institution-application'));
    expect(back).toMatchObject({ status: 'needs_more_info', editable: true, reviewerNote: ['The bank letter is not legible'] });
    await call('rivka', 'POST', `/institution-applications/${id}/account`, { holderName: 'Yeshivat Ohr', iban: OWN_IBAN }, undefined, app, later(4));
    expect(asApp(await call('rivka', 'POST', `/institution-applications/${id}/submit`, undefined, undefined, app, later(5))).status).toBe('submitted');
    expect(await kybCases()).toHaveLength(2);
  });

  it('a second application, staff of an institution, someone else\'s application and the flag off are refused', async () => {
    const again = await call('rivka', 'POST', '/institution-applications', { ...OHR, legalName: 'Ohr Two' }, 'ohr-apply-2');
    expect([again.status, (again.body as { code: string }).code]).toEqual([409, 'IDEMPOTENCY_CONFLICT']);
    expect((await call('staffer', 'POST', '/institution-applications', OHR, 'staffer-apply-1')).status).toBe(409);
    expect((await call('dov', 'POST', `/institution-applications/${id}/submit`)).status).toBe(404);
    expect((await call('dov', 'GET', '/me/institution-application')).status).toBe(404);
    const offR = await call('dov', 'POST', '/institution-applications', OHR, 'dov-apply-1', off);
    expect([offR.status, (offR.body as { code: string }).code]).toEqual([404, 'FEATURE_OFF']);
    const bad = await call('dov', 'POST', '/institution-applications', { ...OHR, registrationNumber: '12' }, 'dov-apply-2');
    expect(bad.status).toBe(422);
  });

  it('a US account is a routing number with a valid checksum and an account number, shown by its last four', () => {
    expect(abaOk('021000021')).toBe(true);
    expect(abaOk('021000022')).toBe(false);
    expect(parseAccount('US', 'Day School Inc.', { holderName: 'Day School', routingNumber: '021000021', accountNumber: '000123456789' }).view).toEqual({ currency: 'USD', holderName: 'Day School', masked: '•••• 6789' });
    expect(() => parseAccount('US', 'Day School', { holderName: 'Day School', routingNumber: '021000022', accountNumber: '1234' })).toThrow(/routing/);
  });
});
