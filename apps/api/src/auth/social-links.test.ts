// T-0694 (REQ-AUTH-004, REQ-AUTH-005): a member's Apple or Google link and the sealed Apple refresh token.
// Runs on the real schema (PGlite) with both repositories: the token is read raw to prove it is not in clear, the
// link and token rows are one transaction, and nothing is logged or put in an error.
import { randomBytes, randomUUID } from 'node:crypto';
import { DomainError, Secret } from '@kesher/domain';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPiiCipher, PiiSealError } from '../crypto/pii.ts';
import { createTestDatabase, type TestDatabase } from '../test-db.ts';
import { PostgresIdentityRepository } from './pg-repository.ts';
import { InMemoryIdentityRepository, type IdentityRepository } from './repository.ts';
import { FEDERATED_TOKEN_COLUMN, SocialLinks } from './social-links.ts';

let db: TestDatabase;
const key = () => new Secret(randomBytes(32).toString('base64'));
const pii = createPiiCipher({ dataKey: key(), indexKey: key() });
const NOW = new Date('2026-11-10T09:00:00Z');
const TOKEN = 'r.apple-refresh-token-0123456789abcdef';

beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.close();
});
afterEach(() => vi.restoreAllMocks());

async function newMember(repo: IdentityRepository): Promise<string> {
  const partyId = randomUUID();
  await repo.createUser({ partyId, phone: `+97254${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`, status: 'active', roles: ['member'], createdAt: NOW.toISOString() });
  return partyId;
}
const conflict = (p: Promise<unknown>) => expect(p).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

for (const [name, make] of [
  ['in memory', () => new InMemoryIdentityRepository()],
  ['Postgres', () => new PostgresIdentityRepository(db, pii)],
] as const) {
  describe(`SocialLinks (${name})`, () => {
    const setup = () => {
      const identity = make();
      return { identity, links: new SocialLinks({ identity, pii, clock: { now: () => NOW } }) };
    };

    it('links Apple with the token sealed, and hands the token back to the revoker only', async () => {
      const { identity, links } = setup();
      const m = await newMember(identity);
      await links.link(m, 'apple', { subject: `apple-${m}`, refreshToken: TOKEN });
      expect(await identity.findFederatedSubject(m, 'apple')).toBe(`apple-${m}`);
      const sealed = await identity.findFederatedToken(m, 'apple');
      expect(Buffer.from(sealed!).includes(Buffer.from(TOKEN))).toBe(false);
      expect(await links.takeForRevoke(m, 'apple')).toBe(TOKEN);
      // Reading does not erase; erasing keeps the link.
      expect(await links.takeForRevoke(m, 'apple')).toBe(TOKEN);
      expect(await links.eraseToken(m, 'apple')).toBe(true);
      expect(await links.eraseToken(m, 'apple')).toBe(false);
      expect(await links.takeForRevoke(m, 'apple')).toBeUndefined();
      expect(await identity.findFederatedSubject(m, 'apple')).toBe(`apple-${m}`);
    });

    it('keeps no token for Google, or for an Apple link made without one', async () => {
      const { identity, links } = setup();
      const m = await newMember(identity);
      await links.link(m, 'google', { subject: `g-${m}`, refreshToken: TOKEN });
      expect(await identity.findFederatedSubject(m, 'google')).toBe(`g-${m}`);
      expect(await links.takeForRevoke(m, 'google')).toBeUndefined();
      const n = await newMember(identity);
      await links.link(n, 'apple', { subject: `a-${n}` });
      expect(await links.takeForRevoke(n, 'apple')).toBeUndefined();
    });

    it('refuses a second link for the member and provider, and a subject another member holds, with 409', async () => {
      const { identity, links } = setup();
      const [a, b] = [await newMember(identity), await newMember(identity)];
      await links.link(a, 'apple', { subject: `s-${a}`, refreshToken: TOKEN });
      await conflict(links.link(a, 'apple', { subject: `other-${a}`, refreshToken: 'second-token-value' }));
      await conflict(links.link(b, 'apple', { subject: `s-${a}`, refreshToken: 'third-token-value' }));
      expect(await identity.findFederatedSubject(a, 'apple')).toBe(`s-${a}`);
      expect(await links.takeForRevoke(a, 'apple')).toBe(TOKEN);
      expect(await identity.findFederatedSubject(b, 'apple')).toBeUndefined();
      expect(await links.takeForRevoke(b, 'apple')).toBeUndefined();
      // One member may hold both providers.
      await links.link(a, 'google', { subject: `g-${a}` });
    });

    it('rejects bad input and an unknown member, creating nothing', async () => {
      const { identity, links } = setup();
      const m = await newMember(identity);
      await expect(links.link(m, 'apple', { subject: '' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(links.link(m, 'apple', { subject: 's', refreshToken: '' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(links.link(m, 'facebook' as 'apple', { subject: 's' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(links.link(randomUUID(), 'apple', { subject: 's' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(await identity.findFederatedSubject(m, 'apple')).toBeUndefined();
    });

    it('never logs the token and never puts it or the subject in an error', async () => {
      const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => undefined));
      const { identity, links } = setup();
      const [a, b] = [await newMember(identity), await newMember(identity)];
      await links.link(a, 'apple', { subject: `secret-subject-${a}`, refreshToken: TOKEN });
      await links.takeForRevoke(a, 'apple');
      const errors: unknown[] = [];
      for (const p of [links.link(a, 'apple', { subject: 'x-subject-1', refreshToken: TOKEN }), links.link(b, 'apple', { subject: `secret-subject-${a}`, refreshToken: TOKEN })]) {
        await p.catch((e: unknown) => errors.push(e));
      }
      expect(errors).toHaveLength(2);
      for (const e of errors) {
        expect(e).toBeInstanceOf(DomainError);
        expect(JSON.stringify(e) + (e as Error).message).not.toContain(TOKEN);
        expect((e as Error).message).not.toContain('secret-subject');
      }
      for (const s of spies) expect(s).not.toHaveBeenCalled();
    });
  });
}

describe('SocialLinks on Postgres at rest', () => {
  const repo = () => new PostgresIdentityRepository(db, pii);

  it('stores the token only as an AES-GCM blob that opens for its own column and no other', async () => {
    const identity = repo();
    const links = new SocialLinks({ identity, pii, clock: { now: () => NOW } });
    const m = await newMember(identity);
    await links.link(m, 'apple', { subject: `s-${m}`, refreshToken: TOKEN });
    const raw = (await db.query<{ refresh_token_sealed: Uint8Array }>(`select refresh_token_sealed from identity.federated_token where party_id = $1`, [m])).rows[0]!.refresh_token_sealed;
    expect(Buffer.from(raw).toString('latin1')).not.toContain(TOKEN);
    expect(Buffer.from(raw).toString('base64')).not.toContain(Buffer.from(TOKEN).toString('base64'));
    expect(pii.open(raw, FEDERATED_TOKEN_COLUMN)).toBe(TOKEN);
    expect(() => pii.open(raw, 'identity.device.push_token')).toThrow(PiiSealError);
    // The whole row, as text, carries no plaintext either.
    expect(JSON.stringify((await db.query(`select * from identity.federated_token where party_id = $1`, [m])).rows)).not.toContain(TOKEN);
  });

  it('writes the link and the token in one transaction: a failed token insert leaves no link', async () => {
    const identity = repo();
    const links = new SocialLinks({ identity, pii, clock: { now: () => NOW } });
    const m = await newMember(identity);
    // An orphan token row for the same key makes the second insert fail after the link insert succeeded.
    await db.query(`insert into identity.federated_token (party_id, provider, refresh_token_sealed, created_at) values ($1, 'apple', $2, $3)`, [m, Buffer.from([9]), NOW.toISOString()]);
    await expect(links.link(m, 'apple', { subject: `s-${m}`, refreshToken: TOKEN })).rejects.toThrow();
    expect((await db.query(`select 1 from ops.external_ref where entity_id = $1`, [m])).rowCount).toBe(0);
  });

  it('sign-in finds a linked member through the row link() wrote (T-0691 shape)', async () => {
    const identity = repo();
    const links = new SocialLinks({ identity, pii, clock: { now: () => NOW } });
    const m = await newMember(identity);
    await links.link(m, 'google', { subject: `sub-${m}` });
    const row = (await db.query(`select entity_type, entity_id, provider, external_id from ops.external_ref where provider = 'google' and external_id = $1`, [`sub-${m}`])).rows[0];
    expect(row).toEqual({ entity_type: 'member', entity_id: m, provider: 'google', external_id: `sub-${m}` });
  });
});
