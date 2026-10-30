// Demo seed (T-0032): makes the personas in personas.ts on a running demo stack (T-0031) through its API
// and its simulator panel only, never by writing tables. Each persona signs up with the simulator's OTP and
// a seeded passkey, has KYC decided through the panel's `kyc/decide` hook (the decision then reaches the
// API as the vendor's webhook), and is funded with card loads. Every call that takes an idempotency key
// gets one derived from the persona, and a persona that already exists is signed in instead of made
// again, so a second run creates nothing and prints the same table.
//
// With a staff signing key (ADMIN_API_SIGNING_KEY, the console's key from .env.local-staff) it also onboards
// the demo yeshiva through /admin/* as two staff admins, grants its finance personas (one admin proposes,
// the other approves), and imports its roster as the first finance persona (T-0034).
//
//   pnpm --filter @kesher/demo seed     (DEMO_API_URL and DEMO_PANEL_URL default to the dev ports)
import { pathToFileURL } from 'node:url';
import { importJWK, SignJWT, type JWK } from 'jose';
import { loadConfig } from '@kesher/domain';
import { SIM_OTP_CODE, type PasskeyAuthenticationOptions, type PasskeyRegistrationOptions } from '@kesher/ports';
import { ApiError, createClient, type Schemas } from '@kesher/sdk';
import { z } from 'zod';
import { DEFAULT_PORT, DEFAULT_SIMULATOR_PORT } from './dev.ts';
import { DEMO_PRICE_RULE, deviceIdOf, INSTITUTION, MISSING, passkeyOf, PERSONAS, rosterCsv, type Persona } from './personas.ts';

export interface SeedTarget {
  /** The API's base URL, with or without /v1. */
  apiUrl: string;
  /** The simulator control panel's base URL. */
  panelUrl: string;
  /** The console's private staff-token key and its kid; without it the yeshiva is not seeded. */
  staffKey?: { jwk: JWK; kid: string } | undefined;
}

export interface SeededInstitution {
  id: string;
  name: string;
  /** Persona keys of its active finance staff. */
  finance: string[];
  rosterStatus: string;
  rosterRows: number;
  /** Each student persona and where their roster row stands after they accept its invite (T-0626). */
  students: { key: string; status: string }[];
}

export interface SeedResult {
  personas: SeededPersona[];
  institution?: SeededInstitution | undefined;
  /** The demo's eSIM price rule and the plans the catalogue sync priced with it (T-0929); needs the staff key. */
  catalogue?: { rule: string; esimPlans: number } | undefined;
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

export async function seed(target: SeedTarget): Promise<SeedResult> {
  const personas: SeededPersona[] = [];
  for (const persona of PERSONAS) personas.push(await seedPersona(target, persona));
  if (!target.staffKey) return { personas };
  return { personas, institution: await seedInstitution(target, target.staffKey, personas), catalogue: await seedCatalogue(target, target.staffKey) };
}

/**
 * The demo's eSIM price rule (T-0929), the way Kesher finance sets one: proposed by one finance member through the
 * admin API, approved by another. A rerun finds the active rule and proposes nothing. Then the nightly catalogue
 * sync runs now from the panel, so the club lists the plans at the rule's prices.
 */
async function seedCatalogue(target: SeedTarget, key: { jwk: JWK; kid: string }): Promise<{ rule: string; esimPlans: number }> {
  const { proposer: proposerSub, approver: approverSub, ...rule } = DEMO_PRICE_RULE;
  const [proposer, approver] = await Promise.all([staffClient(target, key, proposerSub, ['finance']), staffClient(target, key, approverSub, ['finance'])]);
  const same = (r: Schemas['PriceRule']) => r.kind === rule.kind && r.provider === rule.provider && r.skuPattern === rule.skuPattern && r.marginBps === rule.marginBps;
  const { items } = await proposer.get('/admin/price-rules');
  let current = items.find((r) => same(r) && r.state !== 'rejected');
  if (!current) current = await proposer.post('/admin/price-rules', { body: { ...rule, floor: { ...rule.floor } } });
  if (current.state === 'proposed') current = await approver.post('/admin/price-rules/{id}/approve', { path: { id: current.id } });
  const synced = (await panelJob(target, 'catalogue-sync')) as { esim?: { priced: number } } | undefined;
  return { rule: current.state, esimPlans: synced?.esim?.priced ?? 0 };
}

async function panelJob(target: SeedTarget, name: string): Promise<unknown> {
  const res = await fetch(`${target.panelUrl.replace(/\/$/, '')}/jobs/${name}/run`, { method: 'POST' });
  const body = (await res.json()) as { ok?: boolean; result?: unknown; error?: string };
  if (!body.ok) throw new Error(`Panel job ${name} failed: ${body.error ?? res.status}`);
  return body.result;
}

/**
 * The yeshiva through the admin API: created once (keyed), each finance persona proposed by the first admin
 * and approved by the second, then the roster imported by the first finance persona, signed in again so
 * its token carries org_finance. A rerun finds the institution, the active staff and the keyed import.
 */
async function seedInstitution(target: SeedTarget, key: { jwk: JWK; kid: string }, personas: readonly SeededPersona[]): Promise<SeededInstitution> {
  const [proposer, approver] = await Promise.all(INSTITUTION.admins.map((sub) => staffClient(target, key, sub)));
  const yeshiva = await proposer!.post('/admin/institutions', { body: { name: INSTITUTION.name, market: INSTITUTION.market, reason: 'Demo seed: the pilot yeshiva' }, idempotencyKey: `seed-${INSTITUTION.key}-create` });
  const finance = personas.filter((r) => r.persona.staff === 'finance');
  for (const f of finance) {
    const { items } = await proposer!.get('/admin/institutions/{id}/staff', { path: { id: yeshiva.id } });
    if (items.some((s) => s.partyId === f.partyId && s.active && s.role === 'finance')) continue;
    const { grant } = await proposer!.post('/admin/institutions/{id}/staff', { path: { id: yeshiva.id }, body: { partyId: f.partyId, role: 'finance', reason: `Demo seed: ${f.persona.role}` }, idempotencyKey: `seed-${INSTITUTION.key}-finance-${f.persona.key}` });
    if (!grant) throw new Error(`The finance grant for ${f.persona.key} opened no approval`);
    const done = await approver!.post('/admin/staff-grants/{id}/approve', { path: { id: grant.id } });
    if (done.staff?.role !== 'finance') throw new Error(`The finance grant for ${f.persona.key} is ${done.grant?.status ?? 'missing'} after the second approval`);
  }
  await seedKyb(target, key, yeshiva.id, personas);
  const importer = finance[0];
  if (!importer) throw new Error('No finance persona to import the roster');
  const tokens = await signIn(target, importer.persona);
  if (!tokens) throw new Error(`${importer.persona.key} cannot sign in to import the roster`);
  const roster = await memberClient(target, importer.persona, tokens.accessToken).post('/institutions/{id}/rosters', { path: { id: yeshiva.id }, body: { csv: rosterCsv(), mapping: { ...INSTITUTION.roster.mapping }, commit: true }, idempotencyKey: `seed-${INSTITUTION.key}-roster-2` });
  if (roster.status !== 'committed') throw new Error(`The roster import is ${roster.status}: ${JSON.stringify(roster.errors)}`);
  const students = await seedStudents(target, personas);
  const { items } = await proposer!.get('/admin/institutions/{id}/staff', { path: { id: yeshiva.id } });
  const active = new Set(items.filter((s) => s.active && s.role === 'finance').map((s) => s.partyId));
  return { id: yeshiva.id, name: yeshiva.name, finance: finance.filter((f) => active.has(f.partyId)).map((f) => f.persona.key), rosterStatus: roster.status, rosterRows: roster.rowCount, students };
}

/**
 * Each student persona follows the invite their roster row sent (T-0626), as they would from their inbox: the
 * panel's notify outbox has the link, and they accept it signed in. A rerun replays the same accept and gets
 * the same answer. The outbox lives in the dev process's memory, so after a restart a link sent before it is
 * gone; the table says so rather than guessing.
 */
async function seedStudents(target: SeedTarget, personas: readonly SeededPersona[]): Promise<{ key: string; status: string }[]> {
  const out: { key: string; status: string }[] = [];
  for (const row of INSTITUTION.roster.students) {
    const student = personas.find((p) => p.persona.key === row.persona);
    if (!student) throw new Error(`No persona ${row.persona} for the roster`);
    const outbox = (await panelHook(target, 'notify', 'outbox', { to: row.funderEmail })) as { template: string; data: Record<string, string> }[];
    const link = outbox.find((m) => m.template === 'institution.invite' || m.template === 'institution.invite_reminder')?.data['inviteUrl'];
    const token = link ? new URL(link).searchParams.get('token') : undefined;
    if (!token) {
      out.push({ key: row.persona, status: 'link not in the panel outbox (sent before a restart)' });
      continue;
    }
    const tokens = await signIn(target, student.persona);
    if (!tokens) throw new Error(`${row.persona} cannot sign in to accept the invite`);
    const joined = await memberClient(target, student.persona, tokens.accessToken).post('/invites/{token}/accept', { path: { token }, idempotencyKey: `seed-${INSTITUTION.key}-join-${row.persona}` });
    out.push({ key: row.persona, status: joined.status });
  }
  return out;
}

/**
 * The yeshiva's KYB (T-0621, T-0622, ADR-017): until it is approved, its deposits, allowances and payouts
 * stay shut. Compliance names Rivka (T2) its control person and signatory, runs the automated checks against
 * the KybPort simulator (the demo turns every flag on), and approves it at low risk. Then its own bank
 * account (T-0623, T-0625): Cleo records it in the registered name the identifier check found, and Carl, a
 * second compliance member, approves it, so the console can withdraw. A rerun finds each step done and
 * writes nothing.
 */
async function seedKyb(target: SeedTarget, key: { jwk: JWK; kid: string }, institutionId: string, personas: readonly SeededPersona[]): Promise<void> {
  const compliance = await staffClient(target, key, INSTITUTION.compliance, ['compliance']);
  const path = { id: institutionId };
  const record = await compliance.get('/admin/institutions/{id}/kyb', { path });
  // A yeshiva seeded before T-0625 was checked by hand, with no registered name to hold an account in.
  if (!record.checks.some((c) => c.kind === 'identifier' && c.provider !== 'compliance')) {
    const control = personas.find((r) => r.persona.key === INSTITUTION.kybControl);
    if (!control) throw new Error(`No ${INSTITUTION.kybControl} persona to name as the yeshiva's control person`);
    if (!record.people.some((p) => p.partyId === control.partyId)) await compliance.post('/admin/institutions/{id}/kyb/people', { path, body: { fullName: control.persona.name, roles: ['control', 'signatory'], partyId: control.partyId }, idempotencyKey: `seed-${INSTITUTION.key}-kyb-${control.persona.key}` });
    const checked = await compliance.post('/admin/institutions/{id}/kyb/run', { path, body: { identifier: INSTITUTION.identifier, legalName: INSTITUTION.name } });
    if (checked.blocking.length) throw new Error(`The yeshiva's KYB checks left ${checked.blocking.join(', ')}`);
  }
  if (record.decision.status !== 'approved') {
    const { decision } = await compliance.post('/admin/institutions/{id}/kyb/decisions', { path, body: { status: 'approved', risk: 'low', reasons: ['Demo seed: automated checks clear'] }, idempotencyKey: `seed-${INSTITUTION.key}-kyb-decision` });
    if (decision?.status !== 'approved') throw new Error(`The yeshiva's KYB is ${decision?.status ?? 'undecided'} after the seed's decision`);
  }
  const accounts = (await compliance.get('/admin/institutions/{id}/payout-accounts', { path })).items;
  if (accounts[0]?.status === 'active') return;
  const account = accounts[0] ?? (await compliance.post('/admin/institutions/{id}/payout-accounts', { path, body: { iban: INSTITUTION.payoutIban, holderName: INSTITUTION.name, evidenceRef: 'demo-seed: bank account confirmation letter' }, idempotencyKey: `seed-${INSTITUTION.key}-payout-account` }));
  const approver = await staffClient(target, key, INSTITUTION.secondCompliance, ['compliance']);
  const approved = await approver.post('/admin/payout-accounts/{id}/approve', { path: { id: account.id } });
  if (approved.status !== 'active') throw new Error(`The yeshiva's own account is ${approved.status} after a second compliance approval`);
}

/**
 * A staff client signing the console's 5-minute staff token (ADR-013) for a simulator identity-provider
 * subject, with that subject's roles. Development only: the key is the local pair from .env.local-staff,
 * never a deployed console's.
 */
async function staffClient(target: SeedTarget, key: { jwk: JWK; kid: string }, subject: string, roles: readonly string[] = ['admin']): Promise<Client> {
  const signer = await importJWK(key.jwk, 'ES256');
  return createClient({
    baseUrl: apiBase(target),
    getAccessToken: async () => {
      const now = Math.floor(Date.now() / 1000);
      return new SignJWT({ roles: [...roles], sid: `seed:${subject}` }).setProtectedHeader({ alg: 'ES256', kid: key.kid }).setIssuer('kesher-admin').setAudience('kesher-api:admin').setSubject(subject).setIssuedAt(now).setExpirationTime(now + 300).sign(signer);
    },
    newIdempotencyKey: () => {
      throw new Error('Every seed call names its idempotency key, so a rerun replays it');
    },
  });
}

async function seedPersona(target: SeedTarget, p: Persona): Promise<SeededPersona> {
  const tokens = (await signIn(target, p)) ?? (await signUp(target, p));
  const partyId = partyOf(tokens.accessToken);
  const client = memberClient(target, p, tokens.accessToken);

  // The name others see when they pay this persona (T-0531): "Avi Example" reads "Avi E.". Set once; a rerun writes nothing.
  const [firstName, ...rest] = p.name.split(' ');
  if (!(await client.get('/me/display-name')).displayName) await client.patch('/me/display-name', { body: { firstName: firstName!, ...(rest.length ? { lastName: rest.join(' ') } : {}) } });

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
export function formatTable(result: SeedResult): string {
  const rows = result.personas;
  const head = ['persona', 'name', 'market', 'phone', 'party', 'kyc', 'USD', 'ILS', 'card', 'recordings'];
  const body = rows.map((r) => [r.persona.key, r.persona.name, r.persona.market, r.persona.phone, r.partyId, r.kyc, major(r.usd), major(r.ils), r.card, r.persona.recs.join(' ')]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((row) => row[i]!.length)));
  const line = (cells: readonly string[]): string => cells.map((c, i) => c.padEnd(widths[i]!)).join('  ').trimEnd();
  const i = result.institution;
  const institution = i
    ? ['', `Institution: ${i.name} (${INSTITUTION.market}) ${i.id}`, `- finance staff: ${i.finance.join(', ') || 'none'}`, `- roster: ${i.rosterStatus}, ${i.rosterRows} members`, ...i.students.map((st) => `- student ${st.key}: ${st.status}`)]
    : ['', 'Institution: not seeded; set ADMIN_API_SIGNING_KEY and ADMIN_API_SIGNING_KID from .env.local-staff (docs/setup/demo.md)'];
  const catalogue = result.catalogue ? [`Catalogue: eSIM price rule ${result.catalogue.rule}, ${result.catalogue.esimPlans} plans priced`] : [];
  const missing = MISSING.map((m) => `- ${m.who} (${m.recs.join(', ')}): ${m.why}`);
  return [line(head), ...body.map(line), ...institution, ...catalogue, '', 'Not seeded (the contract cannot make them yet):', ...missing].join('\n');
}

const seedConfigSchema = z.object({
  DEMO_API_URL: z.url().default(`http://localhost:${DEFAULT_PORT}`),
  DEMO_PANEL_URL: z.url().default(`http://localhost:${DEFAULT_SIMULATOR_PORT}`),
  /** The console's private staff key (a JWK as JSON) and kid, from .env.local-staff; optional. */
  ADMIN_API_SIGNING_KEY: z.string().optional(),
  ADMIN_API_SIGNING_KID: z.string().default('local-staff-1'),
});

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    const config = loadConfig(seedConfigSchema, process.env);
    const staffKey = config.ADMIN_API_SIGNING_KEY ? { jwk: JSON.parse(config.ADMIN_API_SIGNING_KEY) as JWK, kid: config.ADMIN_API_SIGNING_KID } : undefined;
    process.stdout.write(`${formatTable(await seed({ apiUrl: config.DEMO_API_URL, panelUrl: config.DEMO_PANEL_URL, staffKey }))}\n`);
  } catch (e) {
    process.stderr.write(`seed failed: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }
}
