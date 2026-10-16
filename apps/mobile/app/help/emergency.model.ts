// M32 emergency (T-0730): one button opens a concierge case, dials the emergency line, and (opt-in)
// shares one location fix and tells the funder. Nothing is shared until the member turns it on.
import type { ConciergeApi, EmergencyCase } from '../../src/api.ts';
import type { Device, Position } from '../../src/device.ts';
import type { CopyKey, Locale } from '../../src/i18n.ts';
import type { Opener } from '../../src/linking.ts';
import { createStore, type Store } from '../../src/model.ts';
import { telUrl, type SupportContacts } from '../../src/support.ts';

export interface EmergencyState {
  shareLocation: boolean;
  notifyFunder: boolean;
  note: string;
  busy: boolean;
  locationDenied: boolean;
  opened?: EmergencyCase | undefined;
  error?: CopyKey | undefined;
}

export interface EmergencyDeps {
  concierge: ConciergeApi;
  device: Device;
  opener: Opener;
  support: SupportContacts;
  locale: Locale;
  newKey: () => string;
}

export interface EmergencyModel {
  store: Store<EmergencyState>;
  setShareLocation(on: boolean): void;
  setNotifyFunder(on: boolean): void;
  setNote(note: string): void;
  /** The one button: open the case (idempotent per screen visit) then dial. */
  callForHelp(): Promise<void>;
  /** Dial without a case (after a failure, or again). */
  callNow(): Promise<void>;
  openSettings(): Promise<void>;
}

export function createEmergencyModel(deps: EmergencyDeps): EmergencyModel {
  const store = createStore<EmergencyState>({ shareLocation: false, notifyFunder: false, note: '', busy: false, locationDenied: false });
  // One key per screen visit: a retry after a timeout reuses it, so the help desk sees one case.
  const key = deps.newKey();
  const dial = () => deps.opener.openURL(telUrl(deps.support.emergency));

  return {
    store,
    setShareLocation: (on) => store.patch({ shareLocation: on, locationDenied: false }),
    setNotifyFunder: (on) => store.patch({ notifyFunder: on }),
    setNote: (note) => store.patch({ note: note.slice(0, 500) }),

    async callForHelp() {
      const s = store.get();
      if (s.busy) return;
      if (s.opened) return dial();
      store.patch({ busy: true, error: undefined });
      let location: Position | undefined;
      let locationDenied = false;
      if (s.shareLocation) {
        const r = await deps.device.location.requestOnce();
        if (r.status === 'granted') location = r.position;
        else locationDenied = r.status === 'denied';
      }
      try {
        const opened = await deps.concierge.openEmergencyCase({ locale: deps.locale, notifyFunder: s.notifyFunder, ...(s.note.trim() ? { note: s.note.trim() } : {}), ...(location ? { location } : {}) }, key);
        store.patch({ busy: false, opened, locationDenied });
      } catch {
        store.patch({ busy: false, locationDenied, error: 'emergency.failed' });
      }
      // The call goes out whether or not the case opened: the line is the safety net.
      await dial();
    },

    callNow: () => dial(),
    openSettings: () => deps.opener.openSettings(),
  };
}
