// Institution staff SSO (T-0792, REQ-AUTH-008), dark behind `auth.orgSso` and inert without an `org-idp` binding and `orgIdp.consoleUrl`.
// Four steps: a start (sign-in for a linked identity, or the one-time link of a signed-in staff member), the IdP's callback (302 to ONE
// fixed console URL), and an exchange of a one-time code for the normal token pair. All state lives in `ops.workflow_marker` (no migration):
//  - sso_state: SHA-256 of a 256-bit state in `claim`; value = institution, mode, party, session, invite id, device, challenge, cookie hash, expiry.
//  - sso_state_used: write-once, claimed AFTER the cookie and expiry checks and BEFORE the IdP call: one winner, and a holder of a leaked
//    state with no cookie cannot burn it (the IdP is then called with a decoy state, so it cannot burn the IdP's copy either).
//  - sso_code: SHA-256 of the exchange code; sso_code_attempt (wrong verifiers, cap 5, only for codes that exist); sso_code_used and
//    sso_code_released (a failed device write or token issue releases the claim, so the retry takes the next generation; a crash mid-issue kills the code).
// - The browser binding is a per-state `__Host-` cookie (HttpOnly, Secure, SameSite=Lax), so flows in one browser do not clash.
// - The institution comes only from the stored state; the IdP's email, name and groups are never read. A link is made only for a party who
//   proved control at start (a fresh step-up as active staff, or a valid pending invite, which is consumed here, after the IdP identity is
//   verified), never by email match. Sign-in needs a live link to an ACTIVE staff row; the token carries the user's own stored roles.
// - Every refusal is the same 302 `#error=refused` (an IdP outage `#error=unavailable`) padded to one latency floor, with the same reads.
//   The one write of a refusal after the claim is the consumed state. Reasons go to the closed metric `staff.sso_refused` only.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { DomainError, guarded, isUuidShape, uuidv7, type Metrics } from '@kesher/domain';
import { OrgIdPError, type OrgIdPPort } from '@kesher/ports';
import type { AuthEvent } from '../auth/passkeys.ts';
import type { IdentityRepository } from '../auth/repository.ts';
import { requireStepUp, type StepUpService } from '../auth/step-up.ts';
import type { TokenPair, TokenService } from '../auth/tokens.ts';
import type { FeatureFlags } from '../billing/capabilities.ts';
import type { Database } from '../db.ts';
import { ok, requirePrincipal, route, type Handler, type HttpRequest } from '../http.ts';
import { getMarker, getMarkers, putMarker } from '../ops/workflow-marker.ts';
import { ORG_SSO_FLAG } from './staff-deprovision.ts';
import type { StaffIdpLinks } from './staff-idp-link.ts';
import type { InstitutionTeam } from './team.ts';

export const SIGN_IN_TTL_MS = 10 * 60_000;
export const LINK_TTL_MS = 5 * 60_000;
export const CODE_TTL_MS = 60_000;
export const MAX_VERIFIER_ATTEMPTS = 5;
export const LINK_STARTS_PER_WINDOW = 5;
const LINK_WINDOW_MS = 10 * 60_000;
const MAX_GENERATIONS = 5;
const ZERO = '00000000-0000-0000-0000-000000000000';
/** The closed reasons of `staff.sso_refused`; the caller never sees one. */
export const SSO_REFUSAL_REASONS = ['state_invalid', 'state_unbound', 'state_expired', 'state_replayed', 'idp_refused', 'idp_unavailable', 'org_mismatch', 'not_linked', 'link_refused', 'internal', 'exchange_unknown', 'exchange_expired', 'exchange_verifier', 'exchange_exhausted', 'exchange_stale'] as const;
export type SsoRefusalReason = (typeof SSO_REFUSAL_REASONS)[number];

const hex = (s: string): string => createHash('sha256').update(s).digest('hex');
const rand = (): string => randomBytes(32).toString('base64url');
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER = /^[A-Za-z0-9_-]{43,128}$/;
const STATE = /^[A-Za-z0-9_-]{43,128}$/;
const refused = (): DomainError => new DomainError('UNAUTHENTICATED', 'Sign-in refused');
const cookieName = (state: string): string => `__Host-sso-${hex(state).slice(0, 24)}`;
const cookie = (name: string, value: string, maxAge: number): string => `${name}=${value}; Max-Age=${maxAge}; Path=/; Secure; HttpOnly; SameSite=Lax`;
const equal = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

interface StateRec {
  inst: string;
  mode: 'sign_in' | 'link';
  party?: string;
  session?: string;
  invite?: string;
  device: string;
  challenge: string;
  bind: string;
  exp: number;
}
interface CodeRec {
  party: string;
  inst: string;
  device: string;
  challenge: string;
  exp: number;
}
export interface SsoStart {
  url: string;
  state: string;
  expiresAt: string;
}

export interface StaffSsoDeps {
  db: Database;
  flags: FeatureFlags;
  identity: Pick<IdentityRepository, 'findSession' | 'findUser' | 'upsertDevice'>;
  /** The same sink the passkey and social sign-ins push `new_device_sign_in` to (`PasskeyService.events`). */
  events: Pick<AuthEvent[], 'push'>;
  tokens: Pick<TokenService, 'issue'>;
  links: Pick<StaffIdpLinks, 'find' | 'link'>;
  team: Pick<InstitutionTeam, 'acceptById'>;
  port: () => OrgIdPPort;
  /** An `org-idp` binding exists and the console and callback URLs are configured: otherwise every operation answers FEATURE_OFF. */
  configured: () => boolean;
  /** Institutions with a per-organisation record (the same records the adapter holds). */
  orgs: Readonly<Record<string, unknown>>;
  consoleUrl: string;
  callbackUrl: string;
  metrics: Metrics;
  /** The callback never answers faster than this, so a refusal before the IdP call costs the same as one after it. */
  floorMs?: number;
  sleep?: (ms: number) => Promise<void>;
  hr?: () => number;
}

export class StaffSso {
  private readonly d: StaffSsoDeps;
  private readonly metrics: Metrics;
  constructor(deps: StaffSsoDeps) {
    this.d = deps;
    this.metrics = guarded(deps.metrics);
  }

  /** The flag and the configuration; a flag service that throws is off. Every operation starts here, and the callback and exchange again. */
  async requireOn(): Promise<void> {
    const on = await (async () => this.d.configured() && (await this.d.flags.isOn(ORG_SSO_FLAG)))().catch(() => false);
    if (!on) throw new DomainError('FEATURE_OFF', 'Staff sign-in through an institution IdP is not available yet');
  }

  private institution(id: string): string {
    const inst = isUuidShape(id) ? id.toLowerCase() : '';
    if (!inst || !Object.hasOwn(this.d.orgs, inst)) throw new DomainError('FEATURE_OFF', 'Staff sign-in through an institution IdP is not available yet');
    return inst;
  }

  /** Sign-in start (public): the institution must have an SSO record (one FEATURE_OFF answer for all else). No application counter. */
  async startSignIn(institutionId: string, b: { deviceId: string; challenge: string }, now: Date): Promise<{ body: SsoStart; setCookie: string }> {
    return this.begin(this.institution(institutionId), { mode: 'sign_in', device: b.deviceId, challenge: b.challenge }, SIGN_IN_TTL_MS, now);
  }

  /** Link start: the caller proved a fresh step-up (the handler); membership comes first, and only a member learns anything else. */
  async startLink(p: { partyId: string; sessionId: string; deviceId: string }, institutionId: string, b: { deviceId?: string; challenge: string; inviteToken?: string }, now: Date): Promise<{ body: SsoStart; setCookie: string }> {
    const inst = isUuidShape(institutionId) ? institutionId.toLowerCase() : ZERO;
    const staff = await this.activeStaff(inst, p.partyId);
    const invite = staff || !b.inviteToken ? undefined : await this.pendingInvite('i.token_hash = $1', hex(b.inviteToken), inst, now);
    if (!staff && !invite) throw new DomainError('NOT_FOUND', 'Institution not found');
    this.institution(inst);
    if ((await this.d.db.query('select 1 from org.staff_idp_link where party_id = $1 and unlinked_at is null', [p.partyId])).rowCount) throw new DomainError('IDEMPOTENCY_CONFLICT', 'This account is already linked to an IdP identity');
    await this.countStart(p.partyId, now);
    return this.begin(inst, { mode: 'link', device: b.deviceId ?? p.deviceId, challenge: b.challenge, party: p.partyId, session: p.sessionId, ...(invite ? { invite } : {}) }, LINK_TTL_MS, now);
  }

  private async begin(inst: string, s: Pick<StateRec, 'mode' | 'device' | 'challenge' | 'party' | 'session' | 'invite'>, ttl: number, now: Date): Promise<{ body: SsoStart; setCookie: string }> {
    const state = rand();
    const binding = rand();
    let url: string;
    try {
      url = (await this.d.port().startSso(inst, { state, redirectUri: this.d.callbackUrl })).url;
    } catch (e) {
      if (e instanceof OrgIdPError && e.code === 'UNKNOWN_ORG') throw new DomainError('FEATURE_OFF', 'Staff sign-in through an institution IdP is not available yet');
      if (e instanceof OrgIdPError && e.code === 'PROVIDER_UNAVAILABLE') throw new DomainError('PROVIDER_UNAVAILABLE', 'The institution sign-in is unavailable; try again');
      throw e;
    }
    const exp = now.getTime() + ttl;
    const rec: StateRec = { ...s, inst, bind: hex(binding), exp };
    if (!(await putMarker(this.d.db, { kind: 'sso_state', subjectId: uuidv7(now), value: JSON.stringify(rec), claim: hex(state) }))) throw new Error('sso state collision');
    return { body: { url, state, expiresAt: new Date(exp).toISOString() }, setCookie: cookie(cookieName(state), binding, ttl / 1000) };
  }

  /** The callback's whole answer: a fragment for the fixed console URL and the cookie to clear. Never throws once the flag is on. */
  async callback(q: { code?: string | undefined; state?: string | undefined; error?: string | undefined }, cookieHeader: string | undefined, now: Date): Promise<{ location: string; clear: string }> {
    await this.requireOn();
    const hr = this.d.hr ?? (() => performance.now());
    const t0 = hr();
    let reason: SsoRefusalReason | undefined;
    let fragment: string;
    try {
      const r = await this.callbackInner(q, cookieHeader, now);
      fragment = r.fragment;
      reason = r.reason;
    } catch {
      fragment = 'error=unavailable';
      reason = 'internal';
    }
    if (reason) this.metrics.put({ 'staff.sso_refused': 1 }, { reason });
    const wait = (this.d.floorMs ?? 400) - (hr() - t0);
    if (wait > 0) await (this.d.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))))(wait);
    return { location: `${this.d.consoleUrl}#${fragment}`, clear: cookie(cookieName(q.state ?? ''), '', 0) };
  }

  private async callbackInner(q: { code?: string | undefined; state?: string | undefined; error?: string | undefined }, cookieHeader: string | undefined, now: Date): Promise<{ fragment: string; reason?: SsoRefusalReason }> {
    const state = typeof q.state === 'string' && STATE.test(q.state) ? q.state : undefined;
    const code = typeof q.code === 'string' && q.code.length > 0 && q.code.length <= 2048 ? q.code : undefined;
    const row = (await this.d.db.query<{ subject_id: string; value: string }>("select subject_id, value from ops.workflow_marker where kind = 'sso_state' and claim = $1", [hex(state ?? '')])).rows[0];
    const rec = row ? (JSON.parse(row.value) as StateRec) : undefined;
    const name = cookieName(q.state ?? '');
    const sent = (cookieHeader ?? '').split(';').map((c) => c.trim()).find((c) => c.startsWith(`${name}=`))?.slice(name.length + 1);
    // Constant work whether or not a cookie, a state or a binding exists: the compare always runs.
    const bound = equal(hex(sent ?? ''), rec?.bind ?? hex('')) && sent !== undefined && rec !== undefined;
    const live = rec !== undefined && now.getTime() < rec.exp;
    const usable = state !== undefined && code !== undefined && !q.error;
    let reason: SsoRefusalReason | undefined = !rec || !usable ? 'state_invalid' : !bound ? 'state_unbound' : !live ? 'state_expired' : undefined;
    let claimed = false;
    if (!reason && row) {
      claimed = await putMarker(this.d.db, { kind: 'sso_state_used', subjectId: row.subject_id, value: 'used' });
      if (!claimed) reason = 'state_replayed';
    } else await getMarker(this.d.db, 'sso_state_used', row?.subject_id ?? ZERO);
    // The IdP is called whatever the state was (one latency class); only a claimed state reaches it with the real state and code.
    let identity: Awaited<ReturnType<OrgIdPPort['handleCallback']>> | undefined;
    let outage = false;
    try {
      identity = await this.d.port().handleCallback({ code: claimed ? code! : rand(), state: claimed ? state! : rand() });
    } catch (e) {
      outage = e instanceof OrgIdPError && e.code === 'PROVIDER_UNAVAILABLE';
    }
    if (!claimed) identity = undefined;
    const inst = rec?.inst ?? ZERO;
    const orgOk = !!rec && !!identity && identity.orgId === inst && Object.hasOwn(this.d.orgs, inst);
    const linked = await this.d.links.find(inst, orgOk ? identity!.subject : '');
    const staff = await this.activeStaff(inst, (rec?.mode === 'link' ? rec.party : linked) ?? ZERO);
    if (reason || !rec) return { fragment: 'error=refused', reason: reason ?? 'state_invalid' };
    if (outage) return { fragment: 'error=unavailable', reason: 'idp_unavailable' };
    if (!identity) return { fragment: 'error=refused', reason: 'idp_refused' };
    if (!orgOk) return { fragment: 'error=refused', reason: 'org_mismatch' };
    const party = rec.mode === 'sign_in' ? (staff ? linked : undefined) : await this.completeLink(rec, identity.subject, linked, staff, now);
    if (!party) return { fragment: 'error=refused', reason: rec.mode === 'sign_in' ? 'not_linked' : 'link_refused' };
    const exchange = rand();
    const body: CodeRec = { party, inst, device: rec.device, challenge: rec.challenge, exp: now.getTime() + CODE_TTL_MS };
    if (!(await putMarker(this.d.db, { kind: 'sso_code', subjectId: uuidv7(now), value: JSON.stringify(body), claim: hex(exchange) }))) throw new Error('sso code collision');
    return { fragment: `code=${exchange}` };
  }

  /** Link completion: the starting session is alive, the party is still staff (or the invite is consumed now), nothing is linked yet. */
  private async completeLink(rec: StateRec, subject: string, linked: string | undefined, staff: boolean, now: Date): Promise<string | undefined> {
    const party = rec.party!;
    const session = await this.d.identity.findSession(rec.session!);
    const user = await this.d.identity.findUser(party);
    if (!session || session.revokedAt || session.partyId !== party || !user || user.status === 'closed' || linked) return undefined;
    if ((await this.d.db.query('select 1 from org.staff_idp_link where party_id = $1 and unlinked_at is null', [party])).rowCount) return undefined;
    try {
      if (!staff) {
        if (!rec.invite || !(await this.pendingInvite('i.id = $1', rec.invite, rec.inst, now))) return undefined;
        await this.d.team.acceptById(rec.invite, party, now);
      }
      await this.d.links.link(rec.inst, subject, party, { actorId: party, actorRole: 'org_staff' }, now);
    } catch (e) {
      if (e instanceof DomainError && (e.code === 'IDEMPOTENCY_CONFLICT' || e.code === 'NOT_FOUND')) return undefined;
      throw e;
    }
    return party;
  }

  /** Redeems the one-time code with its verifier: one uniform 401, a wrong verifier counts (cap 5) but does not consume the code. */
  async exchange(b: { code: string; verifier: string }, now: Date): Promise<{ tokens: TokenPair; institutionId: string }> {
    await this.requireOn();
    const fail = (reason: SsoRefusalReason): DomainError => {
      this.metrics.put({ 'staff.sso_refused': 1 }, { reason });
      return refused();
    };
    const row = (await this.d.db.query<{ subject_id: string; value: string }>("select subject_id, value from ops.workflow_marker where kind = 'sso_code' and claim = $1", [hex(b.code)])).rows[0];
    if (!row) throw fail('exchange_unknown');
    const rec = JSON.parse(row.value) as CodeRec;
    const attempts = [...Array(MAX_VERIFIER_ATTEMPTS).keys()];
    if ((await getMarkers(this.d.db, 'sso_code_attempt', row.subject_id, attempts)).size >= MAX_VERIFIER_ATTEMPTS) {
      this.metrics.put({ 'staff.sso_refused': 1 }, { reason: 'exchange_exhausted' });
      throw new DomainError('RATE_LIMITED', 'Too many attempts for this code; sign in again');
    }
    if (now.getTime() >= rec.exp) throw fail('exchange_expired');
    if (!equal(createHash('sha256').update(b.verifier).digest('base64url'), rec.challenge)) {
      for (const seq of attempts) if (await putMarker(this.d.db, { kind: 'sso_code_attempt', subjectId: row.subject_id, seq, value: 'wrong' })) break;
      throw fail('exchange_verifier');
    }
    // Re-checked at redemption: a removal in the 60 seconds since the callback is honoured.
    const live = (await this.d.db.query('select 1 from org.staff_idp_link l join org.staff s on s.party_id = l.party_id and s.institution_id = l.institution_id and s.active where l.party_id = $1 and l.institution_id = $2 and l.unlinked_at is null', [rec.party, rec.inst])).rowCount;
    const user = await this.d.identity.findUser(rec.party);
    if (!live || !user || user.status === 'closed') throw fail('exchange_stale');
    for (let g = 0; g < MAX_GENERATIONS; g += 1) {
      if (!(await putMarker(this.d.db, { kind: 'sso_code_used', subjectId: row.subject_id, seq: g, value: 'used' }))) {
        if ((await getMarker(this.d.db, 'sso_code_released', row.subject_id, g)) !== undefined) continue;
        throw fail('exchange_unknown');
      }
      try {
        // The device first (as passkey and social sign-in do), from the STORED state's device id, on the claimed generation only: a replayed or
        // refused code never reaches here. A failed write fails the exchange and releases the claim like a failed issue (fail closed: no token
        // without the device row, so no session without the alert); a retry finds the device already known and emits nothing a second time.
        const seen = now.toISOString();
        const { isNew } = await this.d.identity.upsertDevice({ partyId: rec.party, deviceId: rec.device, firstSeenAt: seen, lastSeenAt: seen });
        if (isNew) this.d.events.push({ type: 'new_device_sign_in', partyId: rec.party, deviceId: rec.device, at: seen });
        return { tokens: await this.d.tokens.issue({ partyId: rec.party, deviceId: rec.device, roles: user.roles }), institutionId: rec.inst };
      } catch (e) {
        await putMarker(this.d.db, { kind: 'sso_code_released', subjectId: row.subject_id, seq: g, value: 'released' });
        throw e;
      }
    }
    throw fail('exchange_unknown');
  }

  private async activeStaff(inst: string, party: string): Promise<boolean> {
    return (await this.d.db.query('select 1 from org.staff where party_id = $1 and institution_id = $2 and active', [party, inst])).rowCount > 0;
  }

  /** The id of a pending, unexpired invite to THIS institution, read-only (`where` is a literal chosen by the caller). */
  private async pendingInvite(where: 'i.token_hash = $1' | 'i.id = $1', key: string, inst: string, now: Date): Promise<string | undefined> {
    const r = await this.d.db.query<{ id: string }>(`select i.id from org.staff_invite i left join org.staff_invite_acceptance a on a.invite_id = i.id where ${where} and i.institution_id = $2 and a.invite_id is null and i.expires_at > $3`, [key, inst, now]);
    return r.rows[0]?.id;
  }

  /** Per party, in the database (every API process sees it): at most 5 link starts in 10 minutes. */
  private async countStart(party: string, now: Date): Promise<void> {
    const r = await this.d.db.query<{ seq: number; value: string }>("select seq, value from ops.workflow_marker where kind = 'sso_link_start' and subject_id = $1 order by seq desc limit $2", [party, LINK_STARTS_PER_WINDOW]);
    const oldest = r.rows[LINK_STARTS_PER_WINDOW - 1];
    const full = oldest !== undefined && now.getTime() - Number(oldest.value) < LINK_WINDOW_MS;
    if (full || !(await putMarker(this.d.db, { kind: 'sso_link_start', subjectId: party, seq: (r.rows[0]?.seq ?? -1) + 1, value: String(now.getTime()) }))) throw new DomainError('RATE_LIMITED', 'Too many sign-in attempts; try again in a few minutes');
  }
}

const bad = (m: string): DomainError => new DomainError('VALIDATION_FAILED', m);
const str = (v: unknown, min: number, max: number): v is string => typeof v === 'string' && v.length >= min && v.length <= max;

export function staffSsoHandlers(sso: StaffSso, stepUp: StepUpService): Record<string, Handler> {
  const startBody = (req: HttpRequest, link: boolean): { deviceId?: string; challenge: string; inviteToken?: string } => {
    const b = typeof req.body === 'object' && req.body !== null ? (req.body as Record<string, unknown>) : undefined;
    if (!b) throw bad('A JSON body is required');
    if (typeof b['challenge'] !== 'string' || !CHALLENGE.test(b['challenge'])) throw bad('challenge must be the 43-character base64url SHA-256 of the verifier');
    if (b['deviceId'] !== undefined ? !str(b['deviceId'], 1, 128) : !link) throw bad('deviceId is required: 1 to 128 characters');
    if (b['inviteToken'] !== undefined && (!link || !str(b['inviteToken'], 1, 128))) throw bad('inviteToken must be 1 to 128 characters');
    return { challenge: b['challenge'], ...(b['deviceId'] !== undefined ? { deviceId: b['deviceId'] as string } : {}), ...(b['inviteToken'] !== undefined ? { inviteToken: b['inviteToken'] as string } : {}) };
  };
  const started = (r: { body: SsoStart; setCookie: string }) => ({ ...ok(r.body), headers: { 'set-cookie': r.setCookie } });
  return {
    startStaffSso: route(async (req) => {
      await sso.requireOn();
      const b = startBody(req, false);
      return started(await sso.startSignIn(req.params['id'] ?? '', { deviceId: b.deviceId!, challenge: b.challenge }, req.now));
    }),
    startStaffSsoLink: route(async (req) => {
      await sso.requireOn();
      const p = requirePrincipal(req);
      await requireStepUp(stepUp, req);
      return started(await sso.startLink(p, req.params['id'] ?? '', startBody(req, true), req.now));
    }),
    completeStaffSso: route(async (req) => {
      const header = Object.entries(req.headers).find(([k]) => k.toLowerCase() === 'cookie')?.[1];
      const r = await sso.callback({ code: req.query['code'], state: req.query['state'], error: req.query['error'] }, header, req.now);
      return { status: 302, headers: { location: r.location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'set-cookie': r.clear } };
    }),
    exchangeStaffSso: route(async (req) => {
      await sso.requireOn();
      const b = typeof req.body === 'object' && req.body !== null ? (req.body as Record<string, unknown>) : {};
      if (!str(b['code'], 43, 128) || typeof b['verifier'] !== 'string' || !VERIFIER.test(b['verifier'])) throw bad('code and verifier are required: 43 to 128 characters, the verifier base64url');
      return ok(await sso.exchange({ code: b['code'], verifier: b['verifier'] }, req.now));
    }),
  };
}
