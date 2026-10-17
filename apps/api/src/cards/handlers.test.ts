// GET /cards/{id} (T-0402, REQ-CRD-002) over the dispatcher: the owner reads status, controls and
// wallet tokens; nobody reads a PAN, CVV or expiry; a Luhn scan of every response and every log line
// finds no card number.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { uuidv7 } from '@kesher/domain';
import { SimulatorHost } from '@kesher/simulators';
import { generateSigningKey } from '../auth/tokens.ts';
import { StaticFlags } from '../billing/capabilities.ts';
import { createApp, type App } from '../app.ts';
import { dispatch } from '../server.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';

let db: TestDatabase;
let app: App;
const NOW = new Date('2026-11-01T09:00:00Z');
const noa = uuidv7(NOW);
const dana = uuidv7(NOW);
let noaToken = '';
let danaToken = '';
let cardId = '';
const logged: string[] = [];
const responses: unknown[] = [];

/** Luhn check over a digit string; a 13–19 digit run that passes is card-number-shaped. */
export function luhnOk(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}
const cardNumbersIn = (text: string): string[] => (text.match(/\d{13,19}/g) ?? []).filter(luhnOk);

const call = async (method: string, url: string, token?: string) => {
  const r = await dispatch(app, { method, url, headers: token ? { authorization: `Bearer ${token}` } : {}, rawBody: '', now: NOW });
  responses.push(r.body);
  return r;
};

beforeAll(async () => {
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(' ')));
  db = await createTestDatabase();
  const host = new SimulatorHost();
  app = createApp({ db, registry: host.registry, market: 'IL', signingKey: await generateSigningKey(), issuer: 'https://api.kesher.example', clock: () => NOW, flags: new StaticFlags(undefined, { 'card.virtual': true }) });
  noaToken = (await app.services.tokens.issue({ partyId: noa, roles: ['member'], deviceId: 'd1' })).accessToken;
  danaToken = (await app.services.tokens.issue({ partyId: dana, roles: ['member'], deviceId: 'd2' })).accessToken;
  const s = await app.services.kyc.start(noa, 'T2', 'kyc-noa', NOW);
  await dispatch(app, { method: 'POST', url: '/v1/hooks/kyc', headers: { 'x-sim-signature': 'sim' }, rawBody: JSON.stringify({ eventId: 'evt-noa', sessionId: s.sessionId, status: 'approved' }), now: NOW });
  cardId = (await app.services.cards.forParty(noa))[0]!.id;
  await db.query(`insert into cards.card_token (token_id, card_id, wallet, device_id, status) values ('tok_1', $1, 'apple', 'iphone-1', 'active')`, [cardId]);
}, 60_000);
afterEach(() => expect(cardNumbersIn(logged.join('\n'))).toEqual([]));
afterAll(async () => {
  vi.restoreAllMocks();
  await db.close();
});

describe('GET /cards/{id}', () => {
  it('returns the owner’s card with status, controls and tokens, and no card data', async () => {
    const r = await call('GET', `/v1/cards/${cardId}`, noaToken);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      id: cardId,
      type: 'virtual',
      status: 'active',
      last4: expect.stringMatching(/^.{4}$/),
      controls: { blockedMccs: [], atm: false, online: true, agentPurchases: { mode: 'off' } },
      lockedByFunder: [],
      tokens: [{ wallet: 'apple', status: 'active', deviceId: 'iphone-1' }],
    });
    const text = JSON.stringify(r.body);
    expect(text).not.toMatch(/pan|cvv|cvc|expiry|expir|"number"/i);
    expect(cardNumbersIn(text)).toEqual([]);
  });

  it('is the owner’s only: another member gets 404, nobody gets anything without a token', async () => {
    expect((await call('GET', `/v1/cards/${cardId}`, danaToken)).status).toBe(404);
    expect((await call('GET', `/v1/cards/${uuidv7(NOW)}`, noaToken)).status).toBe(404);
    expect((await call('GET', `/v1/cards/${cardId}`)).status).toBe(401);
  });

  it('a Luhn scan over every response so far and every log line finds nothing card-number-shaped', () => {
    expect(responses.length).toBeGreaterThan(0);
    expect(cardNumbersIn(JSON.stringify(responses))).toEqual([]);
    expect(cardNumbersIn(logged.join('\n'))).toEqual([]);
    // The scan itself works: a real test number is caught.
    expect(cardNumbersIn('card 4111111111111111 was declined')).toEqual(['4111111111111111']);
    expect(cardNumbersIn('4111111111111112')).toEqual([]);
  });
});
