// P04 invite your child (T-0308, REQ-BIL-002): the funder names the member and gives a phone (defaulting to +972, as
// members are mostly in Israel) or an email, and sends the invite for the plan chosen in P01–P03. Nothing is charged
// until the member accepts. The form is checked before any call. A retry after a lost answer keeps its Idempotency-Key,
// so it is the same invite; a change to the form is a new one. Below the form, the invites sent, with their state,
// and resend or cancel on an open one.
import { errorIs, type FunderApi, type FunderInvite } from '../../src/api.ts';
import type { CopyKey } from '../../src/i18n.ts';
import { createStore, type Store } from '../../src/model.ts';

export type ContactKind = 'phone' | 'email';

export interface InviteForm {
  memberName: string;
  kind: ContactKind;
  contact: string;
}

export interface FunderInviteState {
  mode: 'loading' | 'ready' | 'error';
  planCode: string;
  form: InviteForm;
  sent: FunderInvite[];
  /** The key of the attempt in flight or being retried; a changed form starts a new attempt. */
  attemptKey?: string | undefined;
  busy: boolean;
  problems: CopyKey[];
  error?: CopyKey | undefined;
  notice?: CopyKey | undefined;
}

export interface FunderInviteDeps {
  funder: Pick<FunderApi, 'invite' | 'invites' | 'resend' | 'cancel'>;
  newKey: () => string;
}

/** "+972 50-123 4567" → "+972501234567"; undefined unless international form. */
export function normalizePhone(text: string): string | undefined {
  const p = text.replace(/[\s()-]/g, '');
  return /^\+[1-9]\d{7,14}$/.test(p) ? p : undefined;
}

/** The form, checked before any call: everything the API would refuse for shape is refused here first. */
export function checkForm(f: InviteForm): { ok: true; body: { memberName: string; phone?: string; email?: string } } | { ok: false; problems: CopyKey[] } {
  const problems: CopyKey[] = [];
  const memberName = f.memberName.trim();
  if (!memberName || memberName.length > 80) problems.push('funder.invite.name.invalid');
  const phone = f.kind === 'phone' ? normalizePhone(f.contact) : undefined;
  const email = f.kind === 'email' ? f.contact.trim().toLowerCase() : undefined;
  if (f.kind === 'phone' && !phone) problems.push('funder.invite.phone.invalid');
  if (f.kind === 'email' && !/^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,24}$/i.test(email ?? '')) problems.push('funder.invite.email.invalid');
  if (problems.length) return { ok: false, problems };
  return { ok: true, body: { memberName, ...(phone ? { phone } : {}), ...(email ? { email } : {}) } };
}

/** An invite's state as a sentence. */
export const stateKey = (i: Pick<FunderInvite, 'status'>): CopyKey => `funder.invite.state.${i.status}` as CopyKey;

export function problemFor(e: unknown): CopyKey {
  if (errorIs(e, { code: 'FORBIDDEN' })) return 'funder.verify.needed';
  if (errorIs(e, { code: 'IDEMPOTENCY_CONFLICT' })) return 'funder.invite.duplicate';
  if (errorIs(e, { code: 'VALIDATION_FAILED' })) return 'funder.invite.refused';
  if (errorIs(e, { code: 'FEATURE_OFF' })) return 'funder.off';
  if (errorIs(e, { status: 503 })) return 'common.error.unavailable';
  return 'common.error.generic';
}

export interface FunderInviteModel {
  store: Store<FunderInviteState>;
  load(): Promise<void>;
  setForm(patch: Partial<InviteForm>): void;
  send(): Promise<void>;
  resend(id: string): Promise<void>;
  cancel(id: string): Promise<void>;
}

export function createFunderInviteModel(deps: FunderInviteDeps, planCode: string): FunderInviteModel {
  const store = createStore<FunderInviteState>({ mode: 'loading', planCode, form: { memberName: '', kind: 'phone', contact: '+972' }, sent: [], busy: false, problems: [] });
  const refresh = async () => store.patch({ sent: [...(await deps.funder.invites()).items] });
  const act = async (fn: () => Promise<unknown>, done: CopyKey) => {
    if (store.get().busy) return;
    store.patch({ busy: true, error: undefined, notice: undefined });
    try {
      await fn();
      await refresh();
      store.patch({ busy: false, notice: done });
    } catch (e) {
      store.patch({ busy: false, error: problemFor(e) });
    }
  };
  return {
    store,

    async load() {
      store.patch({ mode: 'loading', error: undefined });
      try {
        await refresh();
        store.patch({ mode: 'ready' });
      } catch (e) {
        store.patch({ mode: 'error', error: problemFor(e) });
      }
    },

    setForm(patch) {
      const s = store.get();
      const form = { ...s.form, ...patch };
      // Switching to email clears the phone's prefix rather than mailing "+972".
      if (patch.kind && patch.kind !== s.form.kind) form.contact = patch.kind === 'phone' ? '+972' : '';
      store.patch({ form, attemptKey: undefined, problems: [], error: undefined, notice: undefined });
    },

    async send() {
      const s = store.get();
      if (s.busy) return;
      const checked = checkForm(s.form);
      if (!checked.ok) return store.patch({ problems: checked.problems });
      const key = s.attemptKey ?? deps.newKey();
      store.patch({ busy: true, attemptKey: key, problems: [], error: undefined, notice: undefined });
      try {
        await deps.funder.invite({ ...checked.body, planCode: s.planCode }, key);
        await refresh();
        store.patch({ busy: false, attemptKey: undefined, form: { memberName: '', kind: s.form.kind, contact: s.form.kind === 'phone' ? '+972' : '' }, notice: 'funder.invite.sent' });
      } catch (e) {
        // The key stays: a retry after a lost answer is the same invite, never a second SMS.
        store.patch({ busy: false, error: problemFor(e) });
      }
    },

    resend(id) {
      return act(() => deps.funder.resend(id), 'funder.invite.resent');
    },

    cancel(id) {
      return act(() => deps.funder.cancel(id), 'funder.invite.cancelled');
    },
  };
}
