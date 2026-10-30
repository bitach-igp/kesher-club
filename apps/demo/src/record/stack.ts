// The recording stack (T-0920): the T-0031 process on a fresh in-memory database, seeded with the T-0032
// personas and the T-0034 yeshiva, its club rate fetched, then a readiness port the recorder waits on, which
// also answers a member's processor card id for the JIT hook (T-0920), a payout's id at the payout rail for
// its status webhook (T-0927), and proposes a send as a connected assistant would (T-0921).
// Development only, like `pnpm dev`: APP_ENV must be development, and every key comes from the recorder.
//
//   node --experimental-strip-types src/record/stack.ts   (started by playwright.config.ts, not by hand)
import http from 'node:http';
import type { JWK } from 'jose';
import { loadConfig, uuidv7 } from '@kesher/domain';
import { createTestDatabase } from '@kesher/api/test-db';
import { z } from 'zod';
import { log, startDev } from '../dev.ts';
import { formatTable, seed } from '../seed.ts';

const config = loadConfig(
  z.object({
    APP_ENV: z.literal('development'),
    STAFF_JWKS: z.string().min(1),
    ADMIN_API_SIGNING_KEY: z.string().min(1),
    ADMIN_API_SIGNING_KID: z.string().min(1),
    RECORD_READY_PORT: z.coerce.number().int().positive(),
  }),
  process.env,
);

const db = await createTestDatabase();
const dev = await startDev({ ...process.env, DATABASE_URL: 'postgres://record@localhost/in-memory' }, { db });
await dev.runJob('fx-refresh-rates');
const result = await seed({ apiUrl: `http://127.0.0.1:${dev.apiPort}`, panelUrl: `http://127.0.0.1:${dev.panelPort}`, staffKey: { jwk: JSON.parse(config.ADMIN_API_SIGNING_KEY) as JWK, kid: config.ADMIN_API_SIGNING_KID } });
process.stdout.write(`${formatTable(result)}\n`);
// What an assistant's propose_p2p tool call does (apps/api/src/mcp/tools/registry.ts), for REC-09: the
// MCP gateway is not mounted in the running API, so no assistant reaches it over HTTP. The assistant's
// client and its grant for the member are written as the OAuth consent would leave them, then the intent
// goes through the intents service like the tool's call. Development only, like everything in this file.
const ASSISTANT = { clientId: 'https://budget-buddy.example/client', name: 'Budget Buddy' };
async function propose(body: { partyId: string; toPartyId: string; amount: { minor: string; currency: string }; note?: string }): Promise<{ intentId: string; assistant: string }> {
  await db.query(`insert into agent.client (client_id, name, metadata, fetched_at) values ($1, $2, '{}', now()) on conflict (client_id) do nothing`, [ASSISTANT.clientId, ASSISTANT.name]);
  const existing = await db.query<{ id: string }>(`select id from agent.grant where client_id = $1 and party_id = $2 and status = 'active'`, [ASSISTANT.clientId, body.partyId]);
  const grantId = existing.rows[0]?.id ?? uuidv7();
  if (!existing.rows[0]) await db.query(`insert into agent.grant (id, client_id, party_id, scopes, status, created_at) values ($1, $2, $3, $4, 'active', now())`, [grantId, ASSISTANT.clientId, body.partyId, ['p2p:propose']]);
  const intent = await dev.app.services.intents.propose({ grantId, partyId: body.partyId, kind: 'p2p', payload: { fromPartyId: body.partyId, toPartyId: body.toPartyId, amount: body.amount, ...(body.note ? { note: body.note } : {}) } }, dev.app.services.clock.now());
  return { intentId: intent.id, assistant: ASSISTANT.name };
}

// Readiness, and the one thing the recorder cannot ask the product: the processor's id for a member's card,
// which the panel's JIT hook needs to tap it at a till. Members and staff never see processor ids.
http
  .createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/propose') {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString()));
      req.on('end', () => {
        propose(JSON.parse(raw) as Parameters<typeof propose>[0]).then(
          (r) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(r)),
          (e: Error) => res.writeHead(422, { 'content-type': 'application/json' }).end(JSON.stringify({ error: e.message })),
        );
      });
      return;
    }
    // An assistant's call (T-1013): one JSON-RPC message to the API's /mcp with the demo assistant's bearer, once a
    // persona connected it at the panel's /assistant/start. The token never leaves this process.
    if (req.method === 'POST' && req.url === '/mcp') {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString()));
      req.on('end', () => {
        const token = dev.assistant.accessToken();
        if (!token) return void res.writeHead(409, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'connect the demo assistant first: /assistant/start on the panel' }));
        fetch(`http://127.0.0.1:${dev.apiPort}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: raw }).then(
          async (r) => res.writeHead(r.status, { 'content-type': 'application/json' }).end(await r.text()),
          (e: Error) => res.writeHead(502, { 'content-type': 'application/json' }).end(JSON.stringify({ error: e.message })),
        );
      });
      return;
    }
    // The rail's id for a payout, which the panel's payout hook needs to send its status webhook (T-0927). Like
    // processor card ids, staff and members never see it; it lives in ops.external_ref.
    const payout = new URL(req.url ?? '/', 'http://localhost').searchParams.get('payoutOf');
    if (payout) {
      void db.query<{ external_id: string }>(`select external_id from ops.external_ref where entity_type = 'transfer' and entity_id = $1`, [payout]).then((r) => {
        const id = r.rows[0]?.external_id;
        res.writeHead(id ? 200 : 404, { 'content-type': 'application/json' }).end(JSON.stringify(id ? { payoutId: id } : { error: 'not_submitted' }));
      });
      return;
    }
    const party = new URL(req.url ?? '/', 'http://localhost').searchParams.get('cardOf');
    if (!party) return void res.writeHead(200, { 'content-type': 'text/plain' }).end('ready');
    void db.query<{ processor_card_id: string }>(`select processor_card_id from cards.card where party_id = $1 and status = 'active' order by issued_at limit 1`, [party]).then((r) => {
      const id = r.rows[0]?.processor_card_id;
      res.writeHead(id ? 200 : 404, { 'content-type': 'application/json' }).end(JSON.stringify(id ? { processorCardId: id } : { error: 'no_active_card' }));
    });
  })
  .listen(config.RECORD_READY_PORT, () => log('record_ready', { port: config.RECORD_READY_PORT }));
