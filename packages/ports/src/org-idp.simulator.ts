// OrgIdPPort simulator. Fixtures: org "org_outage" -> PROVIDER_UNAVAILABLE; SCIM bearer is
// `scim_<orgId>`; a callback code is `ok:<subject>:<email>[:group1,group2]`.
import { type Clock, fixedClock } from './base.ts';
import { OrgIdPError, type OrgIdentity, type OrgIdPPort, type OrgSsoStart, type ScimEvent } from './org-idp.ts';

interface DirectoryEntry {
  subject: string;
  email: string;
  active: boolean;
}

export class OrgIdPSimulator implements OrgIdPPort {
  private readonly states = new Map<string, string>();
  private readonly directory = new Map<string, Map<string, DirectoryEntry>>();
  private readonly seenEvents = new Map<string, ScimEvent>();

  constructor(readonly clock: Clock = fixedClock(), orgs: readonly string[] = ['org_yeshiva_a', 'org_sem_b']) {
    for (const o of orgs) this.directory.set(o, new Map());
  }

  async startSso(orgId: string, input: { state: string; redirectUri: string }): Promise<OrgSsoStart> {
    if (orgId === 'org_outage') throw new OrgIdPError('PROVIDER_UNAVAILABLE', 'Simulated IdP outage');
    if (!this.directory.has(orgId)) throw new OrgIdPError('UNKNOWN_ORG', `No SSO connection for ${orgId}`);
    this.states.set(input.state, orgId);
    const q = new URLSearchParams({ state: input.state, redirect_uri: input.redirectUri });
    return { url: `https://sso.sim.kesher.example/${orgId}/authorize?${q}`, state: input.state };
  }

  async handleCallback(input: { code: string; state: string }): Promise<OrgIdentity> {
    const orgId = this.states.get(input.state);
    if (!orgId) throw new OrgIdPError('STATE_MISMATCH', 'Unknown state');
    this.states.delete(input.state);
    const m = /^ok:([\w-]+):([^:]+)(?::([\w,-]+))?$/.exec(input.code);
    if (!m) throw new OrgIdPError('INVALID_CODE', 'Code not recognised');
    const [, subject, email, groups] = m;
    const dir = this.directory.get(orgId)!;
    if (!dir.has(subject!)) dir.set(subject!, { subject: subject!, email: email!, active: true });
    else if (!dir.get(subject!)!.active) throw new OrgIdPError('INVALID_CODE', 'User deactivated');
    return { orgId, subject: subject!, email: email!, displayName: email!.split('@')[0]!, groups: groups ? groups.split(',') : [] };
  }

  async parseScimEvent(orgId: string, bearer: string, body: unknown): Promise<ScimEvent> {
    if (bearer !== `scim_${orgId}`) throw new OrgIdPError('SCIM_UNAUTHORIZED', 'Bad SCIM bearer');
    const b = body as Partial<ScimEvent> & { eventId?: string };
    if (!b || typeof b.eventId !== 'string' || typeof b.subject !== 'string' || typeof b.email !== 'string' || !['create', 'update', 'deactivate'].includes(b.op ?? '')) {
      throw new OrgIdPError('SCIM_MALFORMED', 'SCIM event missing fields');
    }
    const prior = this.seenEvents.get(`${orgId}:${b.eventId}`);
    if (prior) return prior;
    const event: ScimEvent = {
      orgId,
      op: b.op!,
      subject: b.subject,
      email: b.email,
      active: b.op !== 'deactivate',
      occurredAt: b.occurredAt ?? this.clock.now().toISOString(),
      eventId: b.eventId,
    };
    const dir = this.directory.get(orgId);
    if (!dir) throw new OrgIdPError('UNKNOWN_ORG', orgId);
    dir.set(event.subject, { subject: event.subject, email: event.email, active: event.active });
    this.seenEvents.set(`${orgId}:${b.eventId}`, event);
    return event;
  }

  async listDirectory(orgId: string): Promise<readonly DirectoryEntry[]> {
    const dir = this.directory.get(orgId);
    if (!dir) throw new OrgIdPError('UNKNOWN_ORG', orgId);
    return [...dir.values()].map((e) => ({ ...e }));
  }
}
