// TST-AUTH-008 (T-1120, contract half of T-0792): the two staff SSO routes exist, are public, and answer 404 FEATURE_OFF with nothing
// stored until the behaviour card (T-0792) replaces the default handler. A reader of the contract sees what the behaviour must do.
import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SimulatorHost } from '@kesher/simulators';
import { generateSigningKey } from '../auth/tokens.ts';
import { createApp, type App } from '../app.ts';
import { match } from '../routes.ts';
import { dispatch } from '../server.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';

let db: TestDatabase;
let app: App;
const INSTITUTION = '0192a7b2-0000-7000-8000-00000000a001';

beforeAll(async () => {
  db = await createTestDatabase();
  app = createApp({ db, registry: new SimulatorHost().registry, market: 'IL', signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example' });
}, 60_000);
afterAll(async () => db.close());

describe('staff SSO routes (T-1120)', () => {
  it('both operations are routed, public, and use the contract paths (GET and POST only)', () => {
    expect(match('POST', `/institutions/${INSTITUTION}/sso/start`)).toMatchObject({ route: { operationId: 'startStaffSso', public: true }, params: { id: INSTITUTION } });
    expect(match('GET', '/sso/callback')).toMatchObject({ route: { operationId: 'completeStaffSso', public: true } });
    expect(match('PUT', '/sso/callback')).toBeUndefined();
    expect(match('POST', '/sso/callback')).toBeUndefined();
  });

  it('answers 404 FEATURE_OFF on both, signed out, and stores nothing', async () => {
    const start = await dispatch(app, { method: 'POST', url: `/v1/institutions/${INSTITUTION}/sso/start`, headers: {}, rawBody: JSON.stringify({ purpose: 'sign_in', deviceId: 'web-1' }) });
    expect(start.status).toBe(404);
    expect(start.body).toMatchObject({ code: 'FEATURE_OFF' });
    const callback = await dispatch(app, { method: 'GET', url: '/v1/sso/callback?code=ok%3Aidp-1%3Aa%40b.c&state=abc', headers: {}, rawBody: '' });
    expect(callback.status).toBe(404);
    expect(callback.body).toMatchObject({ code: 'FEATURE_OFF' });
    expect(callback.headers?.['set-cookie']).toBeUndefined();
    expect((await db.query('select 1 from ops.workflow_marker')).rowCount).toBe(0);
    expect((await db.query('select 1 from org.staff_idp_link')).rowCount).toBe(0);
  });

  it('the contract declares the security rules the behaviour card is bound by', () => {
    const yaml = fs.readFileSync(new URL('../../../../contracts/openapi.yaml', import.meta.url), 'utf8');
    const start = yaml.slice(yaml.indexOf('operationId: startStaffSso'), yaml.indexOf('operationId: completeStaffSso'));
    expect(start).toContain('FEATURE_OFF');
    expect(start).toContain('Set-Cookie');
    expect(start).toContain('X-Step-Up');
    // The optional step-up header must NOT be the shared required `StepUp` parameter: the SDK would then demand it on every sign-in.
    expect(start).not.toContain('#/components/parameters/StepUp');
    const callback = yaml.slice(yaml.indexOf('operationId: completeStaffSso'), yaml.indexOf('operationId: stepUp'));
    expect(callback).toContain('same 401 UNAUTHENTICATED');
    expect(callback).toContain('never from this request');
  });
});
