// "Your name" (T-0532, REQ-PAY-008): the name others see when they pay the member. The member types a first and
// a last name; people paying them see only "Avi E." (T-0531 keeps nothing more). The screen checks the name the
// way the API does before saving, and an API refusal shows as words. The member's own text: shown as written.
import { errorIs, type DisplayName, type DisplayNameApi } from '../../src/api.ts';
import type { CopyKey } from '../../src/i18n.ts';
import { createStore, type Store } from '../../src/model.ts';

const FIRST_NAME_MAX = 40;
const LAST_NAME_MAX = 80;
/** As the API checks it: letters in any script, with spaces, hyphens, apostrophes and Hebrew geresh/gershayim, starting with a letter. */
const NAME = /^\p{L}[\p{L}\p{M}' \-׳״’.]*$/u;

export type NameProblem = 'firstName' | 'lastName';

export interface NameState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  firstName: string;
  lastName: string;
  /** What others see now: "Avi E.", or undefined while none is set. */
  current?: string | undefined;
  saving: boolean;
  problems: NameProblem[];
  notice?: CopyKey | undefined;
  error?: CopyKey | undefined;
}

export interface NameModel {
  store: Store<NameState>;
  load(): Promise<void>;
  setFirstName(v: string): void;
  setLastName(v: string): void;
  save(): Promise<void>;
}

const tidy = (v: string): string => v.normalize('NFC').replace(/\s+/g, ' ').trim();

/** The same rule the API holds; what fails here never leaves the phone. */
export function checkName(firstName: string, lastName: string): NameProblem[] {
  const first = tidy(firstName);
  const last = tidy(lastName);
  const problems: NameProblem[] = [];
  if (!first || first.length > FIRST_NAME_MAX || !NAME.test(first)) problems.push('firstName');
  if (last && (last.length > LAST_NAME_MAX || !NAME.test(last))) problems.push('lastName');
  return problems;
}

/** What others will see, before saving: "Avi E.", or "Avi" alone. */
export function preview(firstName: string, lastName: string): string | undefined {
  const first = tidy(firstName);
  if (!first) return undefined;
  const initial = [...tidy(lastName)][0]?.toLocaleUpperCase();
  return initial ? `${first} ${initial}.` : first;
}

export function createNameModel(deps: { displayName: DisplayNameApi }): NameModel {
  const store = createStore<NameState>({ status: 'idle', firstName: '', lastName: '', saving: false, problems: [] });
  const shown = (d: DisplayName) => d.displayName;
  return {
    store,
    async load() {
      store.patch({ status: 'loading', error: undefined });
      try {
        const d = await deps.displayName.get();
        // The last name was never kept, so only the first name comes back to edit.
        store.patch({ status: 'ready', current: shown(d), firstName: d.firstName ?? '' });
      } catch {
        store.patch({ status: 'error', error: 'common.error.generic' });
      }
    },
    setFirstName(v) {
      store.patch({ firstName: v, problems: [], notice: undefined });
    },
    setLastName(v) {
      store.patch({ lastName: v, problems: [], notice: undefined });
    },
    async save() {
      const s = store.get();
      if (s.saving) return;
      const problems = checkName(s.firstName, s.lastName);
      if (problems.length) return store.patch({ problems });
      store.patch({ saving: true, error: undefined, notice: undefined });
      try {
        const d = await deps.displayName.set(tidy(s.firstName), tidy(s.lastName) || undefined);
        store.patch({ saving: false, current: shown(d), lastName: '', notice: 'name.saved' });
      } catch (e) {
        if (errorIs(e, { code: 'VALIDATION_FAILED' })) return store.patch({ saving: false, problems: [(e as { problem?: { field?: NameProblem } }).problem?.field === 'lastName' ? 'lastName' : 'firstName'] });
        store.patch({ saving: false, error: 'name.saveFailed' });
      }
    },
  };
}
