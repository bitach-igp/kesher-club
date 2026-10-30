import { describe, expect, it } from 'vitest';
import type { InvitesApi } from '../../src/api.ts';
import { memoryRouter } from '../../src/navigation.ts';
import { createInviteModel } from './invite.model.ts';

function fakeInvites(status: 'open' | 'expired' | 'accepted' = 'open') {
  const accepted: string[] = [];
  const api: InvitesApi = {
    async preview(token) {
      if (token === 'missing') throw Object.assign(new Error('nf'), { code: 'NOT_FOUND', status: 404 });
      return { institutionName: 'Yeshivat Or', memberName: 'Avi Example', programme: 'Shiur Alef', status };
    },
    async accept(token, key) {
      if (token === 'taken') throw Object.assign(new Error('nf'), { code: 'NOT_FOUND', status: 404 });
      if (accepted.includes(key)) throw Object.assign(new Error('dup'), { code: 'IDEMPOTENCY_CONFLICT', status: 409 });
      accepted.push(key);
      return { memberId: `m-${token}`, status: 'active' };
    },
  };
  return { api, accepted };
}

describe('M04 invite accept', () => {
  it('shows the institution, roster name and programme, then accepts once and goes home', async () => {
    const { api, accepted } = fakeInvites();
    const router = memoryRouter('/invite');
    const m = createInviteModel({ api, router, token: 'tok-1', signedIn: () => true });
    await m.load();
    expect(m.store.get()).toMatchObject({ mode: 'open', preview: { institutionName: 'Yeshivat Or', memberName: 'Avi Example', programme: 'Shiur Alef' } });
    await m.accept();
    expect(accepted).toEqual(['invite:tok-1']);
    expect(m.store.get().mode).toBe('done');
    expect(router.current()).toBe('/');
  });

  it('expired and already-accepted invites are terminal states, and a missing token is invalid', async () => {
    const expired = createInviteModel({ api: fakeInvites('expired').api, router: memoryRouter(), token: 't', signedIn: () => true });
    await expired.load();
    expect(expired.store.get().mode).toBe('expired');
    await expired.accept();
    expect(expired.store.get().mode).toBe('expired');
    const done = createInviteModel({ api: fakeInvites('accepted').api, router: memoryRouter(), token: 't', signedIn: () => true });
    await done.load();
    expect(done.store.get().mode).toBe('accepted');
    const missing = createInviteModel({ api: fakeInvites().api, router: memoryRouter(), token: 'missing', signedIn: () => true });
    await missing.load();
    expect(missing.store.get()).toMatchObject({ mode: 'error', error: 'invite.invalid' });
    expect(createInviteModel({ api: fakeInvites().api, router: memoryRouter(), token: undefined, signedIn: () => true }).store.get().mode).toBe('error');
  });

  it('a signed-out tap goes to sign-in without accepting (T-0626)', async () => {
    const { api, accepted } = fakeInvites();
    const router = memoryRouter('/invite');
    const m = createInviteModel({ api, router, token: 'tok-1', signedIn: () => false });
    await m.load();
    await m.accept();
    expect(accepted).toEqual([]);
    expect(router.current()).toBe('/sign-in');
    expect(m.store.get().mode).toBe('open');
  });

  it('a link taken or expired since the preview ends on the expired state', async () => {
    const m = createInviteModel({ api: fakeInvites().api, router: memoryRouter(), token: 'taken', signedIn: () => true });
    await m.load();
    await m.accept();
    expect(m.store.get()).toMatchObject({ mode: 'expired', busy: false });
  });
});
