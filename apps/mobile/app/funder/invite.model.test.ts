// T-0308 P04 (TST-BIL-002 at the screen): the form refuses a bad name, phone or email before calling; a phone is
// sent in international form; a retry after a lost answer keeps its Idempotency-Key and a changed form gets a new
// one; a duplicate or a T0 funder reads as a sentence; resend and cancel refresh the list; states read as sentences.
import { describe, expect, it } from 'vitest';
import type { FunderApi, FunderInvite } from '../../src/api.ts';
import { checkForm, createFunderInviteModel, normalizePhone, stateKey } from './invite.model.ts';

class Problem extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

const invite = (over: Partial<FunderInvite> = {}): FunderInvite => ({ id: 'i1', memberName: 'Dana Example', contactKind: 'phone', contact: '•••• 0101', planCode: 'demo-club-us', planVersion: 1, status: 'open', expiresAt: '2026-11-17T09:00:00Z', sentCount: 1, createdAt: '2026-11-10T09:00:00Z', ...over });

function setup(answers: (FunderInvite | Error)[] = []) {
  const calls: { body: Parameters<FunderApi['invite']>[0]; key: string }[] = [];
  const acted: string[] = [];
  let sent: FunderInvite[] = [];
  let n = 0;
  const funder: Pick<FunderApi, 'invite' | 'invites' | 'resend' | 'cancel'> = {
    async invite(body, key) {
      calls.push({ body, key });
      const next = answers.shift() ?? invite();
      if (next instanceof Error) throw next;
      sent = [next, ...sent];
      return next;
    },
    invites: async () => ({ items: sent }),
    async resend(id) {
      acted.push(`resend:${id}`);
      return invite({ id, sentCount: 2 });
    },
    async cancel(id) {
      acted.push(`cancel:${id}`);
      sent = sent.map((i) => (i.id === id ? { ...i, status: 'cancelled' } : i));
      return sent[0]!;
    },
  };
  const model = createFunderInviteModel({ funder, newKey: () => `key-${++n}` }, 'demo-club-us');
  return { model, calls, acted };
}

describe('T-0308 P04 invite your child', () => {
  it('refuses a bad name, phone or email before calling, and sends a phone in international form', async () => {
    expect(normalizePhone('+972 50-123 4567')).toBe('+972501234567');
    expect(normalizePhone('050-123-4567')).toBeUndefined();
    expect(checkForm({ memberName: ' ', kind: 'phone', contact: '+972' })).toEqual({ ok: false, problems: ['funder.invite.name.invalid', 'funder.invite.phone.invalid'] });
    expect(checkForm({ memberName: 'Avi', kind: 'email', contact: 'avi@' })).toEqual({ ok: false, problems: ['funder.invite.email.invalid'] });
    const { model, calls } = setup();
    await model.load();
    model.setForm({ memberName: 'Dana Example', contact: '+1 (555) 555-0101' });
    await model.send();
    expect(calls).toEqual([{ body: { memberName: 'Dana Example', phone: '+15555550101', planCode: 'demo-club-us' }, key: 'key-1' }]);
    expect(model.store.get()).toMatchObject({ notice: 'funder.invite.sent', form: { memberName: '', kind: 'phone', contact: '+972' } });
    expect(model.store.get().sent).toHaveLength(1);
  });

  it('a retry after a lost answer keeps its key; a changed form gets a new one; refusals read as sentences', async () => {
    const { model, calls } = setup([new Problem('PROVIDER_UNAVAILABLE', 503), invite(), new Problem('IDEMPOTENCY_CONFLICT', 409), new Problem('FORBIDDEN', 403)]);
    await model.load();
    model.setForm({ memberName: 'Dana Example', contact: '+15555550101' });
    await model.send();
    expect(model.store.get().error).toBe('common.error.unavailable');
    await model.send();
    expect(calls.map((c) => c.key)).toEqual(['key-1', 'key-1']);
    model.setForm({ memberName: 'Dana Example', contact: '+15555550101' });
    await model.send();
    expect(model.store.get().error).toBe('funder.invite.duplicate');
    model.setForm({ kind: 'email' });
    expect(model.store.get().form.contact).toBe('');
    model.setForm({ contact: 'Avi@Example.com', memberName: 'Avi' });
    await model.send();
    expect(calls.at(-1)).toMatchObject({ body: { email: 'avi@example.com' }, key: 'key-3' });
    expect(model.store.get().error).toBe('funder.verify.needed');
  });

  it('resend and cancel refresh the list; states read as sentences', async () => {
    const { model, acted } = setup();
    await model.load();
    model.setForm({ memberName: 'Dana Example', contact: '+15555550101' });
    await model.send();
    await model.resend('i1');
    expect(model.store.get().notice).toBe('funder.invite.resent');
    await model.cancel('i1');
    expect(acted).toEqual(['resend:i1', 'cancel:i1']);
    expect(model.store.get().sent[0]!.status).toBe('cancelled');
    for (const status of ['open', 'accepted', 'expired', 'cancelled'] as const) expect(stateKey({ status })).toBe(`funder.invite.state.${status}`);
  });
});
