// TST-AUTH-007: 10-minute access tokens, rotating 30-day refresh tokens bound to a device, and
// family revocation when a rotated refresh token is replayed.
import { describe, expect, it } from 'vitest';
import { DomainError } from '@kesher/domain';
import { fixedClock, type AdvanceableClock } from '@kesher/ports';
import { InMemoryIdentityRepository } from './repository.ts';
import { TokenService, generateSigningKey } from './tokens.ts';

async function setup() {
  const clock = fixedClock() as AdvanceableClock;
  const repo = new InMemoryIdentityRepository();
  const svc = new TokenService(repo, await generateSigningKey(), { issuer: 'https://api.kesher.example', audience: 'https://api.kesher.example', clock });
  return { clock, repo, svc };
}

describe('TokenService (REQ-AUTH-007)', () => {
  it('issues a verifiable 10-minute access token and a refresh token bound to the device', async () => {
    const { svc, clock } = await setup();
    const pair = await svc.issue({ partyId: 'p1', deviceId: 'dev-a', roles: ['member'] });
    expect(Date.parse(pair.accessExpiresAt) - clock.now().getTime()).toBe(10 * 60_000);
    const principal = await svc.verifyAccess(pair.accessToken);
    expect(principal).toMatchObject({ partyId: 'p1', deviceId: 'dev-a', roles: ['member'] });
    clock.advance(10 * 60_000 + 1);
    await expect(svc.verifyAccess(pair.accessToken)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('refresh rotates: the old token stops working, the new one works, same session family', async () => {
    const { svc } = await setup();
    const first = await svc.issue({ partyId: 'p1', deviceId: 'dev-a', roles: ['member'] });
    const second = await svc.refresh(first.refreshToken, 'dev-a');
    expect(second.refreshToken).not.toBe(first.refreshToken);
    const p1 = await svc.verifyAccess(first.accessToken);
    const p2 = await svc.verifyAccess(second.accessToken);
    expect(p2.sessionId).toBe(p1.sessionId);
    const third = await svc.refresh(second.refreshToken, 'dev-a');
    expect(third.refreshToken).not.toBe(second.refreshToken);
  });

  it('replaying a rotated refresh token revokes the whole device family (REQ-AUTH-007)', async () => {
    const { svc } = await setup();
    const first = await svc.issue({ partyId: 'p1', deviceId: 'dev-a', roles: ['member'] });
    const second = await svc.refresh(first.refreshToken, 'dev-a');
    await expect(svc.refresh(first.refreshToken, 'dev-a')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    // The legitimate holder of the newest token is locked out too: the family is gone.
    await expect(svc.refresh(second.refreshToken, 'dev-a')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(svc.verifyAccess(second.accessToken)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('a refresh token presented from another device is refused and revokes the family', async () => {
    const { svc } = await setup();
    const pair = await svc.issue({ partyId: 'p1', deviceId: 'dev-a', roles: ['member'] });
    await expect(svc.refresh(pair.refreshToken, 'dev-b')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(svc.refresh(pair.refreshToken, 'dev-a')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('refresh tokens expire after 30 days', async () => {
    const { svc, clock } = await setup();
    const pair = await svc.issue({ partyId: 'p1', deviceId: 'dev-a', roles: ['member'] });
    clock.advance(30 * 24 * 3_600_000 + 1);
    await expect(svc.refresh(pair.refreshToken, 'dev-a')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('revoking a device family ends every session of that device, not the user\'s other devices', async () => {
    const { svc } = await setup();
    const a = await svc.issue({ partyId: 'p1', deviceId: 'dev-a', roles: ['member'] });
    const b = await svc.issue({ partyId: 'p1', deviceId: 'dev-b', roles: ['member'] });
    await svc.revokeDevice('p1', 'dev-a');
    await expect(svc.verifyAccess(a.accessToken)).rejects.toBeInstanceOf(DomainError);
    await expect(svc.verifyAccess(b.accessToken)).resolves.toMatchObject({ deviceId: 'dev-b' });
  });

  it('tokens for a different audience or issuer are rejected', async () => {
    const { svc } = await setup();
    const other = new TokenService(new InMemoryIdentityRepository(), await generateSigningKey(), { issuer: 'https://evil.example', audience: 'https://api.kesher.example' });
    const pair = await other.issue({ partyId: 'p1', deviceId: 'd', roles: ['member'] });
    await expect(svc.verifyAccess(pair.accessToken)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('carries the recovery hold onto access tokens issued during it (REQ-AUTH-003)', async () => {
    const { svc, repo, clock } = await setup();
    await repo.setRestriction('p1', new Date(clock.now().getTime() + 24 * 3_600_000).toISOString(), 'otp_recovery');
    const pair = await svc.issue({ partyId: 'p1', deviceId: 'dev-a', roles: ['member'] });
    expect(pair.restrictedUntil).toBeTruthy();
    expect((await svc.verifyAccess(pair.accessToken)).restrictedUntil).toBe(pair.restrictedUntil);
  });
});
