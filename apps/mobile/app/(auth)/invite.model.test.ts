import { describe, expect, it } from 'vitest';
import type { InvitesApi } from '../../src/api.ts';
import { memoryRouter } from '../../src/navigation.ts';
import { createInviteModel } from './invite.model.ts';

function fakeInvites(status: 'open' | 'expired' | 'accepted' = 'open') {
  const accepted: string[] = [];
  const api: InvitesApi = {
    async preview(token) {
      if (token === 'missing') throw Object.assign(new Error('nf'), { code: 'NOT_FOUND', status: 404 });
      return { funderName: 'Dana Levi', institutionName: 'Yeshivat Or', planCode: 'club.basic', planName: 'Club Basic', status };
    },
    async accept(token, key) {
      if (accepted.includes(key)) throw Object.assign(new Error('dup'), { code: 'IDEMPOTENCY_CONFLICT', status: 409 });
      accepted.push(key);
      return { membershipId: `m-${token}` };
    },
  };
  return { api, accepted };
}

describe('M04 invite accept', () => {
  it('shows funder, institution and plan, then accepts once and goes home', async () => {
    const { api, accepted } = fakeInvites();
    const router = memoryRouter('/invite');
    const m = createInviteModel({ api, router, token: 'tok-1' });
    await m.load();
    expect(m.store.get()).toMatchObject({ mode: 'open', preview: { funderName: 'Dana Levi', institutionName: 'Yeshivat Or', planName: 'Club Basic' } });
    await m.accept();
    expect(accepted).toEqual(['invite:tok-1']);
    expect(m.store.get().mode).toBe('done');
    expect(router.current()).toBe('/');
  });

  it('expired and already-accepted invites are terminal states, and a missing token is invalid', async () => {
    const expired = createInviteModel({ api: fakeInvites('expired').api, router: memoryRouter(), token: 't' });
    await expired.load();
    expect(expired.store.get().mode).toBe('expired');
    await expired.accept();
    expect(expired.store.get().mode).toBe('expired');
    const done = createInviteModel({ api: fakeInvites('accepted').api, router: memoryRouter(), token: 't' });
    await done.load();
    expect(done.store.get().mode).toBe('accepted');
    const missing = createInviteModel({ api: fakeInvites().api, router: memoryRouter(), token: 'missing' });
    await missing.load();
    expect(missing.store.get()).toMatchObject({ mode: 'error', error: 'invite.invalid' });
    expect(createInviteModel({ api: fakeInvites().api, router: memoryRouter(), token: undefined }).store.get().mode).toBe('error');
  });
});
