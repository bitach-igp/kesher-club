// TST-AUTH-008 at the adapter layer (REQ-AUTH-008): institution SSO through WorkOS and SCIM
// deprovisioning through Directory Sync webhooks, against an in-memory WorkOS.
import { describe, expect, it } from 'vitest';
import { fixedClock, type AdvanceableClock } from '@kesher/ports';
import { orgIdPContract } from '@kesher/ports/contracts';
import { fakeWorkOs } from './fake-workos.ts';
import { normaliseEvent, WorkOsOrgIdPAdapter } from './workos.ts';

const API_KEY = 'sk_test_key';
const WEBHOOK_SECRET = 'whsec_test';
const ORGS = {
  org_yeshiva_a: { workosOrganizationId: 'org_workos_yeshiva', directoryId: 'directory_yeshiva', scimBearer: 'scim_org_yeshiva_a' },
  org_sem_b: { workosOrganizationId: 'org_workos_sem', scimBearer: 'scim_org_sem_b' },
  org_outage: { workosOrganizationId: 'org_workos_outage', scimBearer: 'scim_org_outage' },
};

function setup() {
  const clock = fixedClock() as AdvanceableClock;
  const fake = fakeWorkOs({ apiKey: API_KEY, webhookSecret: WEBHOOK_SECRET, directories: { org_workos_yeshiva: 'directory_yeshiva', org_workos_sem: '' } });
  const adapter = new WorkOsOrgIdPAdapter({ clientId: 'client_test', apiKey: API_KEY, orgs: ORGS, webhookSecret: WEBHOOK_SECRET, fetch: fake.fetch, clock });
  return { clock, fake, adapter };
}

orgIdPContract('workos', () => setup().adapter, { orgId: 'org_yeshiva_a', scimBearer: 'scim_org_yeshiva_a', codeFor: (subject, email) => `ok:${subject}:${email}`, outageOrgId: 'org_outage' });

const redirectUri = 'https://console.kesher.example/sso/callback';

describe('WorkOsOrgIdPAdapter', () => {
  it('builds the WorkOS authorize URL for the organisation and exchanges the code with the API key', async () => {
    const { adapter, fake } = setup();
    const s = await adapter.startSso('org_yeshiva_a', { state: 'st1', redirectUri });
    const u = new URL(s.url);
    expect(u.origin + u.pathname).toBe('https://api.workos.com/sso/authorize');
    expect(Object.fromEntries(u.searchParams)).toEqual({ response_type: 'code', client_id: 'client_test', redirect_uri: redirectUri, state: 'st1', organization: 'org_workos_yeshiva' });
    const id = await adapter.handleCallback({ code: 'ok:staff1:staff1@yeshiva.example:admins,finance', state: 'st1' });
    expect(id).toEqual({ orgId: 'org_yeshiva_a', subject: 'staff1', email: 'staff1@yeshiva.example', displayName: 'Staff staff1', groups: ['admins', 'finance'] });
    expect(fake.tokenRequests[0]).toMatchObject({ client_id: 'client_test', client_secret: API_KEY, grant_type: 'authorization_code', code: 'ok:staff1:staff1@yeshiva.example:admins,finance' });
  });

  it('a state is single-use and expires after 10 minutes; a bad code is INVALID_CODE', async () => {
    const { adapter, clock } = setup();
    await adapter.startSso('org_yeshiva_a', { state: 'st1', redirectUri });
    await expect(adapter.handleCallback({ code: 'nope', state: 'st1' })).rejects.toMatchObject({ code: 'INVALID_CODE' });
    await expect(adapter.handleCallback({ code: 'ok:a:a@b', state: 'st1' })).rejects.toMatchObject({ code: 'STATE_MISMATCH' });
    await adapter.startSso('org_yeshiva_a', { state: 'st2', redirectUri });
    clock.advance(11 * 60_000);
    await expect(adapter.handleCallback({ code: 'ok:a:a@b', state: 'st2' })).rejects.toMatchObject({ code: 'STATE_MISMATCH' });
  });

  it("refuses a profile from another organisation's connection", async () => {
    const { adapter } = setup();
    await adapter.startSso('org_yeshiva_a', { state: 'st1', redirectUri });
    await expect(adapter.handleCallback({ code: 'ok:x:x@y;org=org_workos_sem', state: 'st1' })).rejects.toMatchObject({ code: 'STATE_MISMATCH' });
  });

  it('maps Directory Sync webhooks to SCIM events, dedupes by event id, and refuses other organisations', async () => {
    const { adapter } = setup();
    const envelope = { id: 'event_1', event: 'dsync.user.deleted', created_at: '2026-11-01T09:00:00Z', data: { id: 'directory_user_9', idp_id: 'staff9', organization_id: 'org_workos_yeshiva', emails: [{ primary: true, value: 'staff9@yeshiva.example' }], state: 'inactive' } };
    const a = await adapter.parseScimEvent('org_yeshiva_a', 'scim_org_yeshiva_a', envelope);
    expect(a).toEqual({ orgId: 'org_yeshiva_a', op: 'deactivate', subject: 'staff9', email: 'staff9@yeshiva.example', active: false, occurredAt: '2026-11-01T09:00:00Z', eventId: 'event_1' });
    expect(await adapter.parseScimEvent('org_yeshiva_a', 'scim_org_yeshiva_a', envelope)).toEqual(a);
    await expect(adapter.parseScimEvent('org_sem_b', 'scim_org_sem_b', envelope)).rejects.toMatchObject({ code: 'SCIM_UNAUTHORIZED' });
    const created = await adapter.parseScimEvent('org_yeshiva_a', 'scim_org_yeshiva_a', { id: 'event_2', event: 'dsync.user.created', data: { ...envelope.data, idp_id: 'staff10', state: 'active' } });
    expect(created).toMatchObject({ op: 'create', subject: 'staff10', active: true });
    expect(normaliseEvent({ id: 'e', event: 'dsync.user.created', data: { idp_id: 'x', state: 'active', emails: [] } })).toBeUndefined();
    expect(normaliseEvent({ eventId: 'e', op: 'retire', subject: 's', email: 'e' })).toBeUndefined();
  });

  it('lists the directory across pages and overlays deactivations the directory has not caught up with', async () => {
    const { adapter, fake } = setup();
    fake.seedDirectory('directory_yeshiva', [
      { subject: 'u1', email: 'u1@yeshiva.example' },
      { subject: 'u2', email: 'u2@yeshiva.example' },
      { subject: 'u3', email: 'u3@yeshiva.example', active: false },
    ]);
    await adapter.parseScimEvent('org_yeshiva_a', 'scim_org_yeshiva_a', { eventId: 'e1', op: 'deactivate', subject: 'u2', email: 'u2@yeshiva.example' });
    const dir = await adapter.listDirectory('org_yeshiva_a');
    expect(dir).toEqual([
      { subject: 'u1', email: 'u1@yeshiva.example', active: true },
      { subject: 'u2', email: 'u2@yeshiva.example', active: false },
      { subject: 'u3', email: 'u3@yeshiva.example', active: false },
    ]);
    // An organisation without Directory Sync still reports webhook-driven deactivations.
    await adapter.parseScimEvent('org_sem_b', 'scim_org_sem_b', { eventId: 'e2', op: 'deactivate', subject: 'gone', email: 'gone@sem.example' });
    expect(await adapter.listDirectory('org_sem_b')).toEqual([{ subject: 'gone', email: '', active: false }]);
  });

  it('verifies the WorkOS-Signature header within a 5-minute window', () => {
    const { adapter, fake, clock } = setup();
    const raw = '{"id":"event_1"}';
    const now = Math.floor(clock.now().getTime() / 1000);
    expect(adapter.verifyWebhookSignature(fake.sign(raw, now), raw)).toBe(true);
    expect(adapter.verifyWebhookSignature(fake.sign(raw, now), raw.replace('1', '2'))).toBe(false);
    expect(adapter.verifyWebhookSignature(fake.sign(raw, now - 6 * 60), raw)).toBe(false);
    expect(adapter.verifyWebhookSignature('t=abc, v1=', raw)).toBe(false);
    const noSecret = new WorkOsOrgIdPAdapter({ clientId: 'c', apiKey: 'k', orgs: ORGS, fetch: fake.fetch, clock });
    expect(noSecret.verifyWebhookSignature(fake.sign(raw, now), raw)).toBe(false);
  });

  it('an outage, a bad API key and non-JSON bodies all surface as PROVIDER_UNAVAILABLE', async () => {
    const { adapter, fake } = setup();
    fake.setOutage(true);
    await expect(adapter.startSso('org_yeshiva_a', { state: 's', redirectUri })).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    fake.setOutage(false);
    const badKey = new WorkOsOrgIdPAdapter({ clientId: 'c', apiKey: 'wrong', orgs: ORGS, fetch: fake.fetch });
    await expect(badKey.startSso('org_yeshiva_a', { state: 's', redirectUri })).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    const junk = new WorkOsOrgIdPAdapter({ clientId: 'c', apiKey: 'k', orgs: ORGS, fetch: async () => new Response('<html>', { status: 200 }) });
    await expect(junk.listDirectory('org_yeshiva_a')).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(() => new WorkOsOrgIdPAdapter({ clientId: '', apiKey: 'k', orgs: ORGS })).toThrow();
  });
});
