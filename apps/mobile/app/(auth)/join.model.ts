// M04 for a funder's invite (T-0309, REQ-BIL-003): the `join?token=` link a funder's SMS or email carries. The invite
// names who pays and for what, so it is read signed in: a signed-out member is asked to sign in or sign up first, and
// the layout brings them back here (resumable). Then they see the funder, the plan and its price, and accept. Accepting
// starts their membership, charged to the funder once however often it is retried. Extra states (spec): an expired
// invite and one already accepted; a cancelled one reads like an expired one; a card the funder must update reads as a
// plain sentence, and the invite stays open.
import { fromWire, type Money } from '@kesher/domain';
import { errorIs, type FunderApi, type FunderInvitePreview } from '../../src/api.ts';
import type { CopyKey } from '../../src/i18n.ts';
import { createStore, type Store } from '../../src/model.ts';
import type { Router } from '../../src/navigation.ts';

export type JoinMode = 'signin' | 'loading' | 'open' | 'expired' | 'accepted' | 'error' | 'done';

export interface JoinState {
  mode: JoinMode;
  token: string;
  preview?: (Omit<FunderInvitePreview, 'price'> & { price: Money }) | undefined;
  busy: boolean;
  error?: CopyKey | undefined;
}

export interface JoinDeps {
  api: Pick<FunderApi, 'joinPreview' | 'joinAccept'>;
  router: Router;
  token: string | undefined;
  signedIn: () => boolean;
}

/** A preview's state as the screen's mode: cancelled reads as expired, both ask the funder for a new link. */
const modeOf = (status: FunderInvitePreview['status']): JoinMode => (status === 'open' ? 'open' : status === 'accepted' ? 'accepted' : 'expired');

export interface JoinModel {
  store: Store<JoinState>;
  load(): Promise<void>;
  accept(): Promise<void>;
  signIn(): void;
}

export function createJoinModel(deps: JoinDeps): JoinModel {
  const store = createStore<JoinState>({ mode: deps.token ? 'loading' : 'error', token: deps.token ?? '', busy: false, ...(deps.token ? {} : { error: 'join.invalid' as CopyKey }) });
  const preview = async () => {
    const p = await deps.api.joinPreview(store.get().token);
    store.patch({ preview: { ...p, price: fromWire(p.price) }, mode: modeOf(p.status) });
  };
  return {
    store,

    async load() {
      if (!deps.token) return;
      if (!deps.signedIn()) return store.patch({ mode: 'signin' });
      store.patch({ mode: 'loading', error: undefined });
      try {
        await preview();
      } catch (e) {
        store.patch({ mode: 'error', error: errorIs(e, { code: 'NOT_FOUND' }) ? 'join.invalid' : 'common.error.generic' });
      }
    },

    async accept() {
      const s = store.get();
      if (s.mode !== 'open' || s.busy) return;
      store.patch({ busy: true, error: undefined });
      try {
        // The invite is the membership's key on the server; this key only makes a double tap one request.
        await deps.api.joinAccept(s.token, `join:${s.token}`);
        store.patch({ mode: 'done', busy: false });
        deps.router.replace('/');
      } catch (e) {
        if (errorIs(e, { status: 409 })) {
          // Expired, cancelled or taken since the preview: read it again to say which.
          store.patch({ busy: false });
          return preview().catch(() => store.patch({ mode: 'expired' }));
        }
        if (errorIs(e, { code: 'NOT_FOUND' })) return store.patch({ busy: false, mode: 'error', error: 'join.invalid' });
        if (errorIs(e, { code: 'VALIDATION_FAILED' })) return store.patch({ busy: false, error: 'join.declined' });
        store.patch({ busy: false, error: errorIs(e, { status: 503 }) ? 'common.error.unavailable' : 'common.error.generic' });
      }
    },

    signIn() {
      deps.router.push('/sign-in');
    },
  };
}
