// URL opening seam (Linking.openURL, tel:, app settings). Injected so view models are testable.
import { createContext, useContext } from 'react';

export interface Opener {
  openURL(url: string): Promise<void>;
  /** App settings deep link (Linking.openSettings on the real app). */
  openSettings(): Promise<void>;
}

export const OpenerContext = createContext<Opener | undefined>(undefined);
export const OpenerProvider = OpenerContext.Provider;
export function useOpener(): Opener {
  const o = useContext(OpenerContext);
  if (!o) throw new Error('OpenerProvider is missing');
  return o;
}

export function recordingOpener(): Opener & { opened: string[]; settingsOpened: number } {
  const o = {
    opened: [] as string[],
    settingsOpened: 0,
    async openURL(url: string) {
      o.opened.push(url);
    },
    async openSettings() {
      o.settingsOpened += 1;
    },
  };
  return o;
}
