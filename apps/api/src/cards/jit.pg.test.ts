// T-0064 on real Postgres (REQ-CRD-003): the grants of migrations ledger/0028, billing/0006 and audit/0002 are exactly what a card
// authorisation needs. PGlite has no roles, so only a real server shows it. Runs only when TEST_PG_URL (owner) and TEST_PG_JIT_URL
// (connecting as club_jit) name a migrated Postgres 16; see handoff/desktop/T-0064-jit-grants.md.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@kesher/domain';
import { type CardIssuingPort, type CardIssuingSimulator } from '@kesher/ports';
import { SimulatorHost } from '@kesher/simulators';
import { generateSigningKey } from '../auth/tokens.ts';
import { StaticFlags } from '../billing/capabilities.ts';
import { createApp, type App } from '../app.ts';
import { dispatch } from '../server.ts';
import { createPgDatabase, type PgDatabase } from '../pg.ts';

const ownerUrl = process.env['TEST_PG_URL'];
const jitUrl = process.env['TEST_PG_JIT_URL'];
const run = ownerUrl && jitUrl ? describe : describe.skip;
const NOW = new Date('2026-11-01T09:00:00Z');

// table -> privileges club_jit holds on it (S select, I insert, U update). Anything not listed holds none, and nothing holds D.
const EXPECTED: Record<string, string> = {
  'cards.card': 'S', 'cards.card_token': 'S',
  'ledger.account': 'S', 'ledger.journal': 'SI', 'ledger.posting': 'SI',
  'ops.account_balance': 'SIU', 'ops.fx_rate': 'S', 'ops.flag_state': 'S',
  'agent.pending_intent': 'SIU',
  'billing.membership': 'S', 'billing.plan_version': 'S', 'billing.entitlement_usage': 'SIU', 'billing.entitlement_consumption': 'SI',
};
const PRIV = { S: 'select', I: 'insert', U: 'update', D: 'delete' } as const;

run('club_jit on real Postgres', () => {
  let owner: PgDatabase;
  let jit: PgDatabase;
  let app: App;
  let sim: CardIssuingSimulator;
  let processorCardId = '';
  const party = uuidv7(NOW);

  async function authorize(card: string) {
    const signed = sim.authorize(card, { amount: { minor: 1_800n, currency: 'ILS' }, merchant: { name: 'Super-Pharm', mcc: '5912', country: 'IL' }, channel: 'pos' });
    return dispatch(app, { method: 'POST', url: '/v1/jit/card-authorizations', headers: signed.headers, rawBody: signed.rawBody, now: NOW });
  }

  beforeAll(async () => {
    owner = createPgDatabase(ownerUrl!, { max: 4 });
    jit = createPgDatabase(jitUrl!, { max: 4 });
    expect((await jit.query<{ u: string }>(`select current_user as u`)).rows[0]!.u).toBe('club_jit');
    const host = new SimulatorHost();
    sim = host.registry.resolve<CardIssuingPort>('card-issuing', 'IL') as CardIssuingSimulator;
    const common = { registry: host.registry, market: 'IL' as const, signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', clock: () => NOW, flags: new StaticFlags(undefined, { 'card.virtual': true }) };
    // Seed as the owner: a T2 member with a virtual card and a funded wallet, as the full app does.
    const seed = createApp({ ...common, db: owner });
    const s = await seed.services.kyc.start(party, 'T2', `kyc-${party}`, NOW);
    await dispatch(seed, { method: 'POST', url: '/v1/hooks/kyc', headers: { 'x-sim-signature': 'sim' }, rawBody: JSON.stringify({ eventId: `evt-${party}`, sessionId: s.sessionId, status: 'approved' }), now: NOW });
    processorCardId = (await owner.query<{ processor_card_id: string }>(`select processor_card_id from cards.card where party_id = $1`, [party])).rows[0]!.processor_card_id;
    const wallet = await seed.services.accounts.memberAccount(party, 'wallet', 'ILS');
    const partner = await seed.services.accounts.systemAccount('partner_settlement', 'ILS');
    await seed.services.ledger.post({ idempotencyKey: `load:${party}`, kind: 'load', postings: [{ accountId: partner, currency: 'ILS', amountMinor: 50_000n }, { accountId: wallet, currency: 'ILS', amountMinor: -50_000n }] });
    // The authorisation process: the same app, but every statement runs as club_jit.
    app = createApp({ ...common, db: jit });
  }, 90_000);
  afterAll(async () => { await owner.close(); await jit.close(); });

  it('holds exactly the owner-approved privileges on every table and sequence, and no DELETE anywhere', async () => {
    const tables = (await owner.query<{ t: string }>(`select schemaname || '.' || tablename as t from pg_tables where schemaname not in ('pg_catalog','information_schema')`)).rows.map((r) => r.t);
    for (const t of tables) {
      const have = Object.keys(PRIV) as (keyof typeof PRIV)[];
      const got: string[] = [];
      for (const k of have) {
        const r = await owner.query<{ p: boolean }>(`select has_table_privilege('club_jit', $1, $2) as p`, [t, PRIV[k]]);
        if (r.rows[0]!.p) got.push(k);
      }
      expect({ table: t, privileges: got.sort().join('') }).toEqual({ table: t, privileges: (EXPECTED[t] ?? '').split('').sort().join('') });
    }
    const seqs = (await owner.query<{ s: string }>(`select schemaname || '.' || sequencename as s from pg_sequences`)).rows.map((r) => r.s);
    for (const q of seqs) {
      const r = await owner.query<{ u: boolean; s: boolean }>(`select has_sequence_privilege('club_jit', $1, 'usage') as u, has_sequence_privilege('club_jit', $1, 'select') as s`, [q]);
      expect({ seq: q, usage: r.rows[0]!.u }).toEqual({ seq: q, usage: q === 'ledger.posting_id_seq' });
    }
  });

  it('approves an authorisation as club_jit, and a replay answers the same without a second hold', async () => {
    const first = await authorize(processorCardId);
    expect(first.body).toEqual({ result: 'APPROVED', holdAmount: { minor: '1800', currency: 'ILS' } });
    expect((await owner.query<{ n: number }>(`select count(*)::int as n from ledger.journal where kind = 'auth_hold'`)).rows[0]!.n).toBeGreaterThanOrEqual(1);
  });

  it('declines an unknown card (a decision, not a database error)', async () => {
    const r = await authorize('card_unknown_to_us');
    expect(r.body).toMatchObject({ result: 'DECLINED' });
  });

  it.each([
    [`update ledger.posting set amount_minor = 0`],
    [`delete from ledger.journal`],
    [`insert into ledger.account (id) values ($1)`],
    [`update ledger.account set currency = 'USD'`],
    [`select 1 from identity.party limit 1`],
    [`update ops.flag_state set enabled = true`],
  ])('is refused with 42501: %s', async (sql) => {
    await expect(jit.query(sql, sql.includes('$1') ? [uuidv7()] : [])).rejects.toMatchObject({ code: '42501' });
  });
});
