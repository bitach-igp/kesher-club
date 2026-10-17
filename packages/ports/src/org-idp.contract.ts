// OrgIdPPort contract (TST-AUTH-008 at the port layer).
import { describe, expect, it } from 'vitest';
import { OrgIdPError, type OrgIdPPort } from './org-idp.ts';

export interface OrgIdPContractOptions {
  orgId: string;
  scimBearer: string;
  /** Produces a callback code the sandbox accepts for a given staff subject/email. */
  codeFor: (subject: string, email: string) => string;
  outageOrgId?: string;
}

export function orgIdPContract(name: string, make: () => OrgIdPPort, opts: OrgIdPContractOptions): void {
  describe(`OrgIdPPort contract: ${name}`, () => {
    const redirectUri = 'https://console.kesher.example/sso/callback';

    it('starts SSO for a known org and rejects an unknown one', async () => {
      const port = make();
      const s = await port.startSso(opts.orgId, { state: 'st1', redirectUri });
      expect(s.url).toMatch(/^https:\/\//);
      await expect(port.startSso('org_does_not_exist', { state: 'st2', redirectUri })).rejects.toBeInstanceOf(OrgIdPError);
    });

    it('returns an org-scoped identity from the callback and rejects a bad state', async () => {
      const port = make();
      await port.startSso(opts.orgId, { state: 'st1', redirectUri });
      const id = await port.handleCallback({ code: opts.codeFor('staff1', 'staff1@yeshiva.example'), state: 'st1' });
      expect(id.orgId).toBe(opts.orgId);
      expect(id.subject).toBe('staff1');
      await expect(port.handleCallback({ code: opts.codeFor('staff1', 'x@y'), state: 'never-issued' })).rejects.toMatchObject({ code: 'STATE_MISMATCH' });
    });

    it('SCIM deactivate removes console access and duplicate events are idempotent (REQ-AUTH-008)', async () => {
      const port = make();
      await port.startSso(opts.orgId, { state: 'st1', redirectUri });
      await port.handleCallback({ code: opts.codeFor('staff2', 'staff2@yeshiva.example'), state: 'st1' });
      const body = { eventId: 'evt-1', op: 'deactivate', subject: 'staff2', email: 'staff2@yeshiva.example' };
      const a = await port.parseScimEvent(opts.orgId, opts.scimBearer, body);
      const b = await port.parseScimEvent(opts.orgId, opts.scimBearer, body);
      expect(a.active).toBe(false);
      expect(b).toEqual(a);
      const dir = await port.listDirectory(opts.orgId);
      expect(dir.find((e) => e.subject === 'staff2')?.active).toBe(false);
      await port.startSso(opts.orgId, { state: 'st3', redirectUri });
      await expect(port.handleCallback({ code: opts.codeFor('staff2', 'staff2@yeshiva.example'), state: 'st3' })).rejects.toBeInstanceOf(OrgIdPError);
    });

    it('rejects SCIM calls with a wrong bearer or malformed body', async () => {
      const port = make();
      await expect(port.parseScimEvent(opts.orgId, 'wrong', { eventId: 'e', op: 'create', subject: 's', email: 'e' })).rejects.toMatchObject({ code: 'SCIM_UNAUTHORIZED' });
      await expect(port.parseScimEvent(opts.orgId, opts.scimBearer, { op: 'create' })).rejects.toMatchObject({ code: 'SCIM_MALFORMED' });
    });

    if (opts.outageOrgId) {
      it('surfaces outages as PROVIDER_UNAVAILABLE', async () => {
        await expect(make().startSso(opts.outageOrgId!, { state: 's', redirectUri })).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
      });
    }
  });
}
