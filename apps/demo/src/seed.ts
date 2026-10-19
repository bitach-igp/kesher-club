// Demo seed (T-0032): makes the personas in personas.ts on a running demo stack (T-0031) through its API
// and its simulator panel only, never by writing tables. Each persona signs up with the simulator's OTP and
// a seeded passkey, has KYC decided through the panel's `kyc/decide` hook (the decision then reaches the
// API as the vendor's webhook), and is funded with card loads. Every call that takes an idempotency key
// gets one derived from the persona, and a persona that already exists is signed in instead of made
// again, so a second run creates nothing and prints the same table.
//
//   pnpm --filter @kesher/demo seed     (DEMO_API_URL and DEMO_PANEL_URL default to the dev ports)
import { pathToFileURL } from 'node:url';
import { loadConfig } from '@kesher/domain';
import { SIM_OTP_CODE, type PasskeyAuthenticationOptions, type PasskeyRegistrationOptions } from '@kesher/ports';
import { ApiError, createClient, type Schemas } from '@kesher/sdk';
import { z } from 'zod';
import { DEFAULT_PORT, DEFAULT_SIMULATOR_PORT } from './dev.ts';
import { deviceIdOf, MISSING, passkeyOf, PERSONAS, type Persona } from './personas.ts';

export interface SeedTarget {
  /** The API's base URL, with or without /v1. */
  apiUrl: string;
  /** The simulator control panel's base URL. */
  panelUrl: string;
}

export interface SeededPersona {
  persona: Persona;
  partyId: string;
  kyc: 'none' | 'T1' | 'T2';
  usd: bigint;
  ils: bigint;
  /** Status of the persona's newest card, or 'none'. */
  card: string;
}

type Client = ReturnType<typeof createClient>;

/** The contract types the WebAuthn payloads as empty objects; the server reads the simulator's fields. */
const wire = (response: object): Record<string, never> => response as Record<string, never>;

/** The access token's subject is the party id; the seed only reads it, the API verifies it. */
const partyOf = (accessToken: string): string => (JSON.parse(Buffer.from(accessToken.split('.')[1] ?? '', 'base64url').toString('utf8')) as { sub: string }).sub;

export async function seed(target: SeedTarget): Promise<SeededPersona[]> {
  const out: SeededPersona[] = [];
  for (const persona of PERSONAS) out.push(await seedPersona(target, persona));
  return out;
}

async function seedPersona(target: SeedTarget, p: Persona): Promise<SeededPersona> {
  const tokens = (await signIn(target, p)) ?? (await signUp(target, p));
  const partyId = partyOf(tokens.accessToken);
  const client = memberClient(target, p, tokens.accessToken);

  const kyc = await client.get('/kyc/status');
  if (!(kyc.approvedTier === 'T2' || kyc.approvedTier === p.kyc)) {
    const session = await client.post('/kyc/sessions', { body: { tier: p.kyc }, idempotencyKey: `seed-${p.key}-kyc-${p.kyc}` });
    await panelHook(target, 'kyc', 'decide', { sessionId: session.sessionId, status: 'approved' });
    // The vendor's webhook, as the simulator signs it: the panel decided the session, this tells the API.
    const res = await fetch(`${apiBase(target)}/hooks/kyc`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-sim-signature': 'sim' }, body: JSON.stringify({ eventId: `seed-${p.key}-kyc-${p.kyc}`, sessionId: session.sessionId, status: 'approved' }) });
    if (!res.ok) throw new Error(`KYC webhook for ${p.key} answered ${res.status}`);
    const after = await client.get('/kyc/status');
    if (after.status !== 'approved') throw new Error(`KYC for ${p.key} is ${after.status} after the decision`);
  }

  for (const load of p.loads) {
    const res = await client.post('/loads', {
      body: { memberPartyId: partyId, amount: { minor: load.minor.toString(), currency: load.currency }, method: 'card', paymentMethodId: 'pm_ok' },
      idempotencyKey: `seed-${p.key}-load-${load.currency.toLowerCase()}`,
    });
    if (res.state !== 'settled') throw new Error(`The ${load.currency} load for ${p.key} is ${res.state}, not settled`);
  }

  const accounts = (await client.get('/accounts')).items;
  const available = (c: 'USD' | 'ILS'): bigint => BigInt(accounts.find((a) => a.currency === c)?.available.minor ?? '0');
  const cards = (await client.get('/cards')).items;
  const status = await client.get('/kyc/status');
  return { persona: p, partyId, kyc: status.approvedTier ?? 'none', usd: available('USD'), ils: available('ILS'), card: cards.at(-1)?.status ?? 'none' };
}

/** Signs in with the persona's passkey; undefined when the API does not know it yet. */
async function signIn(target: SeedTarget, p: Persona): Promise<Schemas['TokenPair'] | undefined> {
  const anon = createClient({ baseUrl: apiBase(target) });
  const deviceId = deviceIdOf(p);
  const { options } = await anon.post('/auth/passkeys/authenticate', { body: { deviceId } });
  try {
    const { tokens } = await anon.post('/auth/passkeys/authenticate', { body: { deviceId, response: wire(await (await passkeyOf(p)).authenticate(options as unknown as PasskeyAuthenticationOptions)) } });
    return tokens;
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return undefined;
    throw e;
  }
}

async function signUp(target: SeedTarget, p: Persona): Promise<Schemas['TokenPair']> {
  const anon = createClient({ baseUrl: apiBase(target) });
  const started = await anon.post('/auth/otp', { body: { phone: p.phone, locale: 'en' } });
  const verified = await anon.post('/auth/otp/verify', { body: { otpId: started.otpId, code: SIM_OTP_CODE, purpose: 'register' } });
  const otpSession = createClient({ baseUrl: apiBase(target), getAccessToken: () => verified.otpSessionToken });
  const begin = { deviceId: deviceIdOf(p), deviceName: 'Demo seed', purpose: 'register' as const };
  try {
    const { options } = await otpSession.post('/auth/passkeys/register', { body: begin });
    const finish = { ...begin, response: wire(await (await passkeyOf(p)).register(options as unknown as PasskeyRegistrationOptions)) };
    const { tokens } = await otpSession.post('/auth/passkeys/register', { body: finish });
    if (!tokens) throw new Error(`Sign-up for ${p.key} returned no tokens`);
    return tokens;
  } catch (e) {
    if (e instanceof ApiError && e.code === 'IDEMPOTENCY_CONFLICT') throw new Error(`${p.phone} (${p.key}) already has an account whose passkey is not this seed's; reset the demo database`, { cause: e });
    throw e;
  }
}

/** A member's client: every keyed call names its key, and each money call gets a fresh passkey step-up. */
function memberClient(target: SeedTarget, p: Persona, accessToken: string): Client {
  const client: Client = createClient({
    baseUrl: apiBase(target),
    getAccessToken: () => accessToken,
    getStepUpToken: async () => {
      const { options } = await client.post('/auth/step-up', { body: {} });
      const { stepUpToken } = await client.post('/auth/step-up', { body: { response: wire(await (await passkeyOf(p)).authenticate(options as unknown as PasskeyAuthenticationOptions)) } });
      if (!stepUpToken) throw new Error(`Step-up for ${p.key} returned no token`);
      return stepUpToken;
    },
    newIdempotencyKey: () => {
      throw new Error('Every seed call names its idempotency key, so a rerun replays it');
    },
  });
  return client;
}

async function panelHook(target: SeedTarget, capability: string, hook: string, args: Record<string, string>): Promise<unknown> {
  const res = await fetch(`${target.panelUrl.replace(/\/$/, '')}/ports/${capability}/hooks/${hook}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args) });
  const body = (await res.json()) as { ok?: boolean; result?: unknown; error?: string; detail?: string };
  if (!body.ok) throw new Error(`Panel hook ${capability}/${hook} failed: ${body.error ?? res.status} ${body.detail ?? ''}`.trim());
  return body.result;
}

const apiBase = (target: SeedTarget): string => {
  const base = target.apiUrl.replace(/\/$/, '');
  return base.endsWith('/v1') ? base : `${base}/v1`;
};

const major = (minor: bigint): string => {
  const sign = minor < 0n ? '-' : '';
  const abs = minor < 0n ? -minor : minor;
  return `${sign}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`;
};

/** The table the seed prints: the same on every run against the same database. */
export function formatTable(rows: readonly SeededPersona[]): string {
  const head = ['persona', 'name', 'market', 'phone', 'party', 'kyc', 'USD', 'ILS', 'card', 'recordings'];
  const body = rows.map((r) => [r.persona.key, r.persona.name, r.persona.market, r.persona.phone, r.partyId, r.kyc, major(r.usd), major(r.ils), r.card, r.persona.recs.join(' ')]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((row) => row[i]!.length)));
  const line = (cells: readonly string[]): string => cells.map((c, i) => c.padEnd(widths[i]!)).join('  ').trimEnd();
  const missing = MISSING.map((m) => `- ${m.who} (${m.recs.join(', ')}): ${m.why}`);
  return [line(head), ...body.map(line), '', 'Not seeded (the contract cannot make them yet):', ...missing].join('\n');
}

const seedConfigSchema = z.object({
  DEMO_API_URL: z.url().default(`http://localhost:${DEFAULT_PORT}`),
  DEMO_PANEL_URL: z.url().default(`http://localhost:${DEFAULT_SIMULATOR_PORT}`),
});

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    const config = loadConfig(seedConfigSchema, process.env);
    process.stdout.write(`${formatTable(await seed({ apiUrl: config.DEMO_API_URL, panelUrl: config.DEMO_PANEL_URL }))}\n`);
  } catch (e) {
    process.stderr.write(`seed failed: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }
}
