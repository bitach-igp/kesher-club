// T-0309 M04 for a funder's invite (TST-BIL-003 at the screen): signed out, the member is asked to sign in before any
// call; signed in, the preview names who pays and the plan's price in bigint; accepting twice is one call per tap and
// lands at Home; a 409 reads the invite again to say expired or accepted; a declined card stays on the invite with a
// sentence; an unknown link reads as invalid; no token is invalid without a call.
import { describe, expect, it } from 'vitest';
import { money } from '@kesher/domain';
import type { FunderApi, FunderInvitePreview } from '../../src/api.ts';
import { createJoinModel } from './join.model.ts';

class Problem extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

const preview = (over: Partial<FunderInvitePreview> = {}): FunderInvitePreview => ({ funderName: 'Ben E.', memberName: 'Dana Example', planCode: 'demo-club-us', planName: 'Demo Club US', price: { minor: '4900', currency: 'USD' }, termMonths: 10, status: 'open', ...over });

function setup(opts: { signedIn?: boolean; previews?: (FunderInvitePreview | Error)[]; accepts?: Error[]; token?: string | undefined } = {}) {
  const calls: string[] = [];
  const routed: string[] = [];
  const previews = [...(opts.previews ?? [preview()])];
  const accepts = [...(opts.accepts ?? [])];
  const api: Pick<FunderApi, 'joinPreview' | 'joinAccept'> = {
    async joinPreview(token) {
      calls.push(`preview:${token}`);
      const next = previews.shift() ?? preview();
      if (next instanceof Error) throw next;
      return next;
    },
    async joinAccept(token, key) {
      calls.push(`accept:${token}:${key}`);
      const next = accepts.shift();
      if (next) throw next;
      return {} as Awaited<ReturnType<FunderApi['joinAccept']>>;
    },
  };
  const router = { push: (h: string) => void routed.push(`push:${h}`), replace: (h: string) => void routed.push(`replace:${h}`), back: () => undefined };
  const model = createJoinModel({ api, router, token: 'token' in opts ? opts.token : 'tok-1234567890abcdef', signedIn: () => opts.signedIn ?? true });
  return { model, calls, routed };
}

describe('T-0309 M04 accepts a funder invite', () => {
  it('signed out asks to sign in before any call; no token is invalid without a call', async () => {
    const out = setup({ signedIn: false });
    await out.model.load();
    expect(out.model.store.get().mode).toBe('signin');
    out.model.signIn();
    expect([out.calls, out.routed]).toEqual([[], ['push:/sign-in']]);
    const none = setup({ token: undefined });
    await none.model.load();
    expect([none.model.store.get().mode, none.model.store.get().error, none.calls]).toEqual(['error', 'join.invalid', []]);
  });

  it('signed in, the preview names who pays and the price in bigint; accepting lands at Home, once per tap', async () => {
    const { model, calls, routed } = setup();
    await model.load();
    expect(model.store.get()).toMatchObject({ mode: 'open', preview: { funderName: 'Ben E.', planName: 'Demo Club US', price: money(4_900n, 'USD'), termMonths: 10 } });
    await Promise.all([model.accept(), model.accept()]);
    expect(calls.filter((c) => c.startsWith('accept'))).toEqual(['accept:tok-1234567890abcdef:join:tok-1234567890abcdef']);
    expect([model.store.get().mode, routed]).toEqual(['done', ['replace:/']]);
  });

  it('a 409 reads the invite again to say expired or accepted; a declined card stays open with a sentence; an unknown link is invalid', async () => {
    const late = setup({ previews: [preview(), preview({ status: 'cancelled' })], accepts: [new Problem('IDEMPOTENCY_CONFLICT', 409)] });
    await late.model.load();
    await late.model.accept();
    expect(late.model.store.get().mode).toBe('expired');

    const taken = setup({ previews: [preview(), preview({ status: 'accepted' })], accepts: [new Problem('IDEMPOTENCY_CONFLICT', 409)] });
    await taken.model.load();
    await taken.model.accept();
    expect(taken.model.store.get().mode).toBe('accepted');

    const declined = setup({ accepts: [new Problem('VALIDATION_FAILED', 422)] });
    await declined.model.load();
    await declined.model.accept();
    expect(declined.model.store.get()).toMatchObject({ mode: 'open', error: 'join.declined', busy: false });

    const unknown = setup({ previews: [new Problem('NOT_FOUND', 404)] });
    await unknown.model.load();
    expect([unknown.model.store.get().mode, unknown.model.store.get().error]).toEqual(['error', 'join.invalid']);
  });
});
