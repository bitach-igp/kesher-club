// TST-AGT-004 (REQ-AGT-004): provider calls never carry a user token. Every MCP tool runs against the
// real adapters a tool call can reach (Airalo for eSIM usage, Twilio, Expo push and Postmark for the
// intent notifications, the card-issuing simulator for card status), each behind a fetch that records
// every outbound request. Three secrets are live during the run: the member's access token (from a
// real passkey registration), a fresh step-up token, and the agent's audience-bound token. None of
// them may appear anywhere in any outbound request; every outbound request must carry the adapter's
// own service credential; and nothing may reach the real network.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey } from 'jose';
import { money, uuidv7 } from '@kesher/domain';
import { AuthSimulator, CardIssuingSimulator, SIM_OTP_CODE, SimPasskeyDevice, fixedClock, type NotifyPort } from '@kesher/ports';
import { AiraloEsimAdapter, ExpoPushNotifyAdapter, FakeAiralo, PostmarkNotifyAdapter, TwilioNotifyAdapter } from '@kesher/adapters';
import { InMemoryIdentityRepository } from '../auth/repository.ts';
import { OtpService } from '../auth/otp.ts';
import { PasskeyService } from '../auth/passkeys.ts';
import { StepUpService } from '../auth/step-up.ts';
import { TokenService, generateSigningKey } from '../auth/tokens.ts';
import { IntentService } from '../intents/service.ts';
import { AccountService } from '../ledger/accounts.ts';
import { PostgresLedger } from '../ledger/post.ts';
import { TransferService } from '../transfers/service.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import type { AgentPrincipal } from './auth.ts';
import { McpTokenValidator } from './auth.ts';
import { McpGateway } from './gateway.ts';
import { TOOLS, type ToolContext } from './tools/registry.ts';

const RESOURCE = 'https://api.kesher.example/mcp';
const AS = 'https://auth.kesher.example';
const CLIENT = 'https://assistant.example/.well-known/oauth-client';
const PHONE = '+972501234567';
const CREDENTIALS = {
  airalo: { clientId: 'airalo-client', clientSecret: 'airalo-secret-0f3a' },
  twilio: { accountSid: 'AC00000000000000000000000000000000', authToken: 'twilio-auth-7c21' },
  expo: { accessToken: 'expo-access-91ab' },
  postmark: { serverToken: 'postmark-server-55de' },
};

interface Outbound {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

/** Wraps a fake provider so every request the adapter makes is kept, verbatim, for inspection. */
function recording(name: string, inner: typeof fetch, log: (o: Outbound & { provider: string }) => void): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).forEach((v, k) => {
      headers[k] = v;
    });
    log({ provider: name, url, method: (init?.method ?? 'GET').toUpperCase(), headers, body: typeof init?.body === 'string' ? init.body : init?.body ? String(init.body) : '' });
    return inner(input, init);
  }) as typeof fetch;
}

/** Minimal provider stand-ins: they answer success in each vendor's wire shape and check the service credential. */
function fakeTwilio(): typeof fetch {
  let n = 0;
  return (async (_input: string | URL | Request, init?: RequestInit) => {
    const auth = new Headers(init?.headers).get('authorization');
    if (auth !== `Basic ${Buffer.from(`${CREDENTIALS.twilio.accountSid}:${CREDENTIALS.twilio.authToken}`).toString('base64')}`) return Response.json({ code: 20003, message: 'Authenticate' }, { status: 401 });
    return Response.json({ sid: `SM${++n}`, status: 'queued' }, { status: 201 });
  }) as typeof fetch;
}
function fakeExpo(): typeof fetch {
  let n = 0;
  return (async (_input: string | URL | Request, init?: RequestInit) => {
    if (new Headers(init?.headers).get('authorization') !== `Bearer ${CREDENTIALS.expo.accessToken}`) return new Response('unauthorized', { status: 401 });
    return Response.json({ data: [{ status: 'ok', id: `ticket_${++n}` }] });
  }) as typeof fetch;
}
function fakePostmark(): typeof fetch {
  let n = 0;
  return (async (_input: string | URL | Request, init?: RequestInit) => {
    if (new Headers(init?.headers).get('x-postmark-server-token') !== CREDENTIALS.postmark.serverToken) return Response.json({ ErrorCode: 10, Message: 'Bad token' }, { status: 401 });
    return Response.json({ MessageID: `pm_${++n}`, ErrorCode: 0, Message: 'OK' });
  }) as typeof fetch;
}

let db: TestDatabase;
let gateway: McpGateway;
let agentKey: { privateKey: CryptoKey; publicKey: CryptoKey };
const outbound: (Outbound & { provider: string })[] = [];
const seenPrincipals: AgentPrincipal[] = [];
const secrets: Record<'memberAccessToken' | 'memberRefreshToken' | 'stepUpToken' | 'agentToken', string> = { memberAccessToken: '', memberRefreshToken: '', stepUpToken: '', agentToken: '' };
let member = '';
let accountId = '';
const grantId = uuidv7();
const now = new Date('2026-11-01T09:00:00Z');
const realFetch = globalThis.fetch;

beforeAll(async () => {
  db = await createTestDatabase();
  const clock = fixedClock(now.toISOString());

  // A real member: OTP, passkey registration, a 10-minute access token, then a fresh step-up token.
  const repo = new InMemoryIdentityRepository();
  const authPort = new AuthSimulator(clock);
  const otp = new OtpService(authPort, repo, clock);
  const tokens = new TokenService(repo, await generateSigningKey(), { issuer: 'https://api.kesher.example', audience: 'https://api.kesher.example', clock });
  const passkeys = new PasskeyService(authPort, repo, tokens, clock, otp);
  const stepUp = new StepUpService(authPort, repo, clock);
  const started = await otp.start({ phone: PHONE, locale: 'he' });
  const verified = await otp.verify({ otpId: started.otpId, code: SIM_OTP_CODE, purpose: 'register' });
  const device = new SimPasskeyDevice();
  const s1 = await passkeys.register({ otpSessionToken: verified.otpSessionToken!, deviceId: 'iphone-1', deviceName: 'Noa' });
  const s2 = await passkeys.register({ otpSessionToken: verified.otpSessionToken!, deviceId: 'iphone-1', deviceName: 'Noa', response: await device.register(s1.options!) });
  secrets.memberAccessToken = s2.tokens!.accessToken;
  secrets.memberRefreshToken = s2.tokens!.refreshToken;
  const principal = await tokens.verifyAccess(secrets.memberAccessToken);
  member = principal.partyId;
  const su1 = await stepUp.start(principal);
  secrets.stepUpToken = (await stepUp.complete(principal, await device.authenticate(su1.options))).stepUpToken;

  // The agent's token from the authorization server, bound to the MCP resource and a live grant.
  agentKey = await generateKeyPair('ES256', { extractable: true });
  const jwk = await exportJWK(agentKey.publicKey);
  await db.query(`insert into agent.client (client_id, name, metadata, fetched_at) values ($1, 'Assistant', '{}', now())`, [CLIENT]);
  await db.query(`insert into agent.grant (id, client_id, party_id, scopes, status, created_at) values ($1, $2, $3, $4, 'active', now())`, [grantId, CLIENT, member, TOOLS.map((t) => t.scope)]);
  secrets.agentToken = await new SignJWT({ scope: TOOLS.map((t) => t.scope).join(' '), grant_id: grantId, client_id: CLIENT })
    .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
    .setIssuer(AS)
    .setAudience(RESOURCE)
    .setSubject(member)
    .setIssuedAt(Math.floor(now.getTime() / 1000) - 10)
    .setExpirationTime(Math.floor(now.getTime() / 1000) + 3600)
    .sign(agentKey.privateKey);

  // Adapters in play, each on a recording fetch over a fake provider. Nothing else may use fetch.
  const log = (o: Outbound & { provider: string }) => outbound.push(o);
  const fakeAiralo = new FakeAiralo({ ...CREDENTIALS.airalo, clock });
  const esim = new AiraloEsimAdapter({ ...CREDENTIALS.airalo, fetch: recording('airalo', fakeAiralo.fetch, log), clock });
  const sms: NotifyPort = new TwilioNotifyAdapter({ ...CREDENTIALS.twilio, from: { sms: '+12025550100' }, templates: { 'agent.intent': { en: 'Your assistant proposed {{kind}}; approve in the app', he: 'העוזר הציע {{kind}}; אשרו באפליקציה' } }, fetch: recording('twilio', fakeTwilio(), log) });
  const push: NotifyPort = new ExpoPushNotifyAdapter({ ...CREDENTIALS.expo, templates: { 'agent.intent': { title: { en: 'Approval needed', he: 'נדרש אישור' }, body: { en: '{{kind}} waits for you', he: '{{kind}} מחכה לאישור' } } }, fetch: recording('expo', fakeExpo(), log) });
  const email: NotifyPort = new PostmarkNotifyAdapter({ ...CREDENTIALS.postmark, from: 'club@kesher.example', templates: { 'agent.intent': { en: 'agent-intent-en', he: 'agent-intent-he' } }, fetch: recording('postmark', fakePostmark(), log) });
  const cards = new CardIssuingSimulator(clock);
  const { cardholderId } = await cards.createCardholder({ partyId: member, kycSessionId: 'kyc_ok' }, `ch:${member}`);
  const card = await cards.issueCard({ cardholderId, type: 'virtual', controls: { blockedMccs: [], atm: false, online: true, agentPurchases: 'off' } }, `card:${member}`);
  const esimOrder = await esim.order('israel-7days-1gb', `esim:${member}`);
  outbound.length = 0; // the order above is setup, not a tool call

  const ledger = new PostgresLedger(db);
  const accounts = new AccountService(db, ledger);
  accountId = await accounts.memberAccount(member, 'wallet', 'USD');
  const notifyAll = async (partyId: string, intent: { id: string; kind: string }) => {
    const data = { kind: intent.kind, partyId };
    await Promise.all([
      sms.send({ channel: 'sms', to: PHONE, template: 'agent.intent', locale: 'he', data, category: 'security' }, `sms:${intent.id}`),
      push.send({ channel: 'push', to: 'ExponentPushToken[noa-iphone-1]', template: 'agent.intent', locale: 'he', data, category: 'security' }, `push:${intent.id}`),
      email.send({ channel: 'email', to: 'noa@example.com', template: 'agent.intent', locale: 'he', data, category: 'security' }, `email:${intent.id}`),
    ]);
  };
  const intents = new IntentService(db, new TransferService(db), stepUp, notifyAll);
  const ctx = (at: Date): ToolContext => ({
    now: at,
    accounts: async (m) => (await accounts.purses(m)).map((p) => ({ id: p.id, currency: p.currency, settled: p.settled, holds: p.holds, available: p.available })),
    transactions: async () => [{ id: 't1', kind: 'card', amount: money(1_800n, 'ILS'), at: '2026-10-30T12:00:00Z', state: 'settled', merchantName: 'Super-Pharm', mcc: '5912' }],
    card: async () => ({ id: card.cardId, status: (await cards.getCard(card.cardId)).status, controls: {}, last4: card.last4 }),
    esimUsage: async () => {
      const u = await esim.getUsage(esimOrder.iccid);
      return [{ iccid: u.iccid, usedMb: u.usedMb, totalMb: u.totalMb, expiresAt: u.expiresAt }];
    },
    setCardStatus: async (_m, status, p) => {
      seenPrincipals.push(p);
      const c = await cards.setStatus(card.cardId, status, `status:${status}:${at.getTime()}`);
      return { id: c.cardId, status: c.status };
    },
    proposeIntent: async (kind, payload, p) => {
      seenPrincipals.push(p);
      const i = await intents.propose({ grantId: p.grantId, partyId: p.partyId, kind, payload }, at);
      return { intentId: i.id, expiresAt: i.expiresAt };
    },
  });
  const validator = new McpTokenValidator(db, { jwks: { keys: [{ ...jwk, kid: 'k1', alg: 'ES256', use: 'sig' }] }, issuer: AS }, RESOURCE);
  gateway = new McpGateway({ resource: RESOURCE, authorizationServers: [AS] }, db, validator, ctx);

  // Anything that reaches the ambient fetch is a leak path by itself.
  vi.stubGlobal('fetch', async (input: unknown) => {
    throw new Error(`ambient fetch used for ${String(input)}`);
  });
}, 60_000);
afterEach(() => expect(globalThis.fetch).not.toBe(realFetch));
afterAll(async () => {
  vi.unstubAllGlobals();
  await db.close();
});

const argsFor = (name: string): Record<string, unknown> => {
  switch (name) {
    case 'list_transactions':
    case 'spending_summary':
      return { accountId };
    case 'propose_limit_change':
      return { dailyLimit: { minor: '50000', currency: 'ILS' } };
    case 'propose_p2p':
      return { toPartyId: uuidv7(), amount: { minor: '5000', currency: 'ILS' }, note: 'rent' };
    case 'propose_load':
      return { amount: { minor: '10000', currency: 'USD' } };
    default:
      return {};
  }
};

const serialise = (o: Outbound): string => `${o.method} ${o.url}\n${JSON.stringify(o.headers)}\n${o.body}`;

describe('provider calls never carry a user token (TST-AGT-004)', () => {
  it('every tool succeeds against the real adapters, so the recording covers the whole surface', async () => {
    for (const tool of TOOLS) {
      const r = await gateway.call(`Bearer ${secrets.agentToken}`, { name: tool.name, arguments: argsFor(tool.name) }, { now });
      expect(r.status, tool.name).toBe(200);
    }
    const providers = new Set(outbound.map((o) => o.provider));
    expect([...providers].sort()).toEqual(['airalo', 'expo', 'postmark', 'twilio']);
    // Three intents (unfreeze, limit, p2p, load) notified on three channels each, plus the eSIM usage read.
    expect(outbound.filter((o) => o.provider === 'twilio')).toHaveLength(4);
    expect(outbound.filter((o) => o.provider === 'expo')).toHaveLength(4);
    expect(outbound.filter((o) => o.provider === 'postmark')).toHaveLength(4);
    expect(outbound.filter((o) => o.provider === 'airalo').length).toBeGreaterThan(0);
  });

  it('no outbound request carries the member access token, the refresh token, the step-up token or the agent token', () => {
    for (const [name, value] of Object.entries(secrets)) expect(value, name).not.toBe('');
    expect(outbound.length).toBeGreaterThan(0);
    for (const o of outbound) {
      const wire = serialise(o);
      for (const [name, value] of Object.entries(secrets)) {
        expect(wire, `${name} in ${o.provider} ${o.method} ${o.url}`).not.toContain(value);
        // A token split across header values or URL-encoded would still be a leak.
        expect(wire).not.toContain(encodeURIComponent(value));
        expect(wire).not.toContain(Buffer.from(value).toString('base64'));
      }
    }
  });

  it('every outbound request authenticates with the adapter’s own service credential and nothing else', () => {
    const twilioBasic = `Basic ${Buffer.from(`${CREDENTIALS.twilio.accountSid}:${CREDENTIALS.twilio.authToken}`).toString('base64')}`;
    for (const o of outbound) {
      switch (o.provider) {
        case 'twilio':
          expect(o.headers['authorization']).toBe(twilioBasic);
          break;
        case 'expo':
          expect(o.headers['authorization']).toBe(`Bearer ${CREDENTIALS.expo.accessToken}`);
          break;
        case 'postmark':
          expect(o.headers['x-postmark-server-token']).toBe(CREDENTIALS.postmark.serverToken);
          expect(o.headers['authorization']).toBeUndefined();
          break;
        case 'airalo':
          if (o.url.endsWith('/v2/token')) {
            // The adapter exchanges its own client credentials for a provider token; no bearer yet.
            expect(o.body).toContain(`client_id=${CREDENTIALS.airalo.clientId}`);
            expect(o.body).toContain(`client_secret=${CREDENTIALS.airalo.clientSecret}`);
            expect(o.headers['authorization']).toBeUndefined();
          } else {
            // Every other call bears the provider-issued token the fake handed out, never one of ours.
            expect(o.headers['authorization']).toMatch(/^Bearer \S+$/);
          }
          break;
        default:
          throw new Error(`unexpected provider ${o.provider}`);
      }
    }
  });

  it('tools receive a principal, never a token: nothing token-shaped reaches the tool context', () => {
    expect(seenPrincipals.length).toBeGreaterThan(0);
    for (const p of seenPrincipals) {
      expect(Object.keys(p).sort()).toEqual(['clientId', 'grantId', 'memberPartyIds', 'partyId', 'scopes']);
      const text = JSON.stringify(p);
      for (const value of Object.values(secrets)) expect(text).not.toContain(value);
    }
  });

  it('the agent token alone is what the gateway checks; a member access token is not an agent credential', async () => {
    const r = await gateway.call(`Bearer ${secrets.memberAccessToken}`, { name: 'get_balances', arguments: {} }, { now });
    expect(r.status).toBe(401);
    const r2 = await gateway.call(`Bearer ${secrets.stepUpToken}`, { name: 'get_balances', arguments: {} }, { now });
    expect(r2.status).toBe(401);
    // Refusals make no provider call.
    expect(outbound.filter((o) => o.url.includes('balances'))).toHaveLength(0);
  });
});
