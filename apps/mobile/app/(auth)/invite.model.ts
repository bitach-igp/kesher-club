// M04 invite accept (T-0113, T-0626): a roster invite link opens here. The preview is public and names the
// institution and the roster row; accepting needs the member signed in, so a signed-out tap goes to sign-in
// and the layout brings them back here. The member accepts once (idempotent by invite token).
import { errorIs, type InvitePreview, type InvitesApi } from '../../src/api.ts';
import type { CopyKey } from '../../src/i18n.ts';
import { createStore, type Store } from '../../src/model.ts';
import type { Router } from '../../src/navigation.ts';

export type InviteMode = 'loading' | 'open' | 'expired' | 'accepted' | 'error' | 'done';

export interface InviteState {
  mode: InviteMode;
  token: string;
  preview?: InvitePreview | undefined;
  busy: boolean;
  error?: CopyKey | undefined;
}

export interface InviteModel {
  store: Store<InviteState>;
  load(): Promise<void>;
  accept(): Promise<void>;
}

export function createInviteModel(deps: { api: InvitesApi; router: Router; token: string | undefined; signedIn: () => boolean; homeHref?: string }): InviteModel {
  const store = createStore<InviteState>({ mode: deps.token ? 'loading' : 'error', token: deps.token ?? '', busy: false, ...(deps.token ? {} : { error: 'invite.invalid' as CopyKey }) });
  return {
    store,
    async load() {
      if (!deps.token) return;
      store.patch({ mode: 'loading', error: undefined });
      try {
        const preview = await deps.api.preview(deps.token);
        store.patch({ preview, mode: preview.status === 'open' ? 'open' : preview.status });
      } catch (e) {
        store.patch({ mode: 'error', error: errorIs(e, { code: 'NOT_FOUND' }) ? 'invite.invalid' : 'common.error.generic' });
      }
    },
    async accept() {
      const s = store.get();
      if (s.mode !== 'open') return;
      if (!deps.signedIn()) return deps.router.push('/sign-in');
      store.patch({ busy: true, error: undefined });
      try {
        // The token itself is the idempotency key: a double tap or retry accepts once.
        await deps.api.accept(s.token, `invite:${s.token}`);
        store.patch({ mode: 'done', busy: false });
        deps.router.replace(deps.homeHref ?? '/');
      } catch (e) {
        if (errorIs(e, { code: 'IDEMPOTENCY_CONFLICT' }) || errorIs(e, { status: 409 })) return store.patch({ mode: 'accepted', busy: false });
        // Expired, or taken by someone else since the preview: the link is no use either way.
        if (errorIs(e, { code: 'NOT_FOUND' })) return store.patch({ mode: 'expired', busy: false });
        store.patch({ busy: false, error: 'common.error.generic' });
      }
    },
  };
}
