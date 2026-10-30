// T-0532 "Your name" (screen rows of TST-PAY-008): saving "Avi" and "Example" shows "Avi E."; the screen checks
// the name the way the API does, so digits never leave the phone; an API refusal shows as words on its field;
// a failure keeps what the member typed.
import { describe, expect, it } from 'vitest';
import { ApiError } from '@kesher/sdk';
import type { DisplayName, DisplayNameApi } from '../../src/api.ts';
import { checkName, createNameModel, preview } from './name.model.ts';

function fake(initial: DisplayName = {}, fail?: unknown) {
  const calls: { firstName: string; lastName?: string | undefined }[] = [];
  let current = initial;
  const api: DisplayNameApi = {
    async get() {
      return current;
    },
    async set(firstName, lastName) {
      calls.push({ firstName, lastName });
      if (fail) throw fail;
      const lastInitial = lastName ? [...lastName][0]!.toLocaleUpperCase() : undefined;
      current = { displayName: lastInitial ? `${firstName} ${lastInitial}.` : firstName, firstName, ...(lastInitial ? { lastInitial } : {}) };
      return current;
    },
  };
  return { api, calls };
}

describe('Your name (T-0532)', () => {
  it('saving "Avi" and "Example" shows "Avi E.", and the preview says so before saving', async () => {
    const { api, calls } = fake();
    const m = createNameModel({ displayName: api });
    await m.load();
    expect(m.store.get()).toMatchObject({ status: 'ready', current: undefined, firstName: '' });
    m.setFirstName('  Avi ');
    m.setLastName('Example');
    expect(preview(m.store.get().firstName, m.store.get().lastName)).toBe('Avi E.');
    await m.save();
    expect(calls).toEqual([{ firstName: 'Avi', lastName: 'Example' }]);
    expect(m.store.get()).toMatchObject({ current: 'Avi E.', notice: 'name.saved', lastName: '', saving: false });
  });

  it('reopens with the first name only: the last name was never kept', async () => {
    const m = createNameModel({ displayName: fake({ displayName: 'Avi E.', firstName: 'Avi', lastInitial: 'E' }).api });
    await m.load();
    expect(m.store.get()).toMatchObject({ current: 'Avi E.', firstName: 'Avi', lastName: '' });
  });

  it('a name with digits, a URL or an emoji is refused before the call', async () => {
    expect(checkName('Avi2', '')).toEqual(['firstName']);
    expect(checkName('https://x.example', '')).toEqual(['firstName']);
    expect(checkName('Avi 🙂', '')).toEqual(['firstName']);
    expect(checkName('Avi', 'Ex4mple')).toEqual(['lastName']);
    expect(checkName('נועה', 'כ״ץ')).toEqual([]);
    const { api, calls } = fake();
    const m = createNameModel({ displayName: api });
    await m.load();
    m.setFirstName('Avi2');
    await m.save();
    expect(calls).toEqual([]);
    expect(m.store.get().problems).toEqual(['firstName']);
  });

  it('an API refusal shows on its field; any other failure says so and keeps what was typed', async () => {
    const refused = new ApiError(422, { type: 'about:blank', title: 'Invalid', status: 422, code: 'VALIDATION_FAILED', field: 'lastName' } as never);
    const r = createNameModel({ displayName: fake({}, refused).api });
    await r.load();
    r.setFirstName('Avi');
    r.setLastName('Example');
    await r.save();
    expect(r.store.get()).toMatchObject({ problems: ['lastName'], saving: false });
    const down = createNameModel({ displayName: fake({}, new ApiError(503, { type: 'about:blank', title: 'Down', status: 503, code: 'PROVIDER_UNAVAILABLE' } as never)).api });
    await down.load();
    down.setFirstName('Avi');
    await down.save();
    expect(down.store.get()).toMatchObject({ error: 'name.saveFailed', firstName: 'Avi', saving: false });
  });
});
