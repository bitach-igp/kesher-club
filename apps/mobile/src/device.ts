// Device facts and OS permissions the screens need, behind a context so tests inject them.
// The real app binds expo-device / expo-location / expo-clipboard here.
import { createContext, useContext } from 'react';

export interface DeviceInfo {
  platform: 'ios' | 'android';
  /** "17.4" style; compared numerically by major.minor. */
  osVersion: string;
  esimCapable: boolean;
}

export interface Position {
  lat: number;
  lng: number;
  accuracyM: number;
}

export type LocationResult = { status: 'granted'; position: Position } | { status: 'denied' } | { status: 'unavailable' };

export interface Location {
  /** Asks for foreground permission if needed and returns one fix. Never caches across cases. */
  requestOnce(): Promise<LocationResult>;
}

export interface Clipboard {
  copy(text: string): Promise<void>;
}

export type ScanResult = { status: 'granted'; payload: string } | { status: 'denied' } | { status: 'unavailable' } | { status: 'cancelled' };
export interface Camera {
  /** Asks for camera permission if needed and scans one QR code (M19). */
  scanOnce(): Promise<ScanResult>;
}

export interface Contact {
  name: string;
  /** E.164 where the OS gives one; the API resolves it, the app never guesses. */
  phone: string;
}
export type ContactsResult = { status: 'granted'; contact: Contact } | { status: 'denied' } | { status: 'cancelled' };
export interface Contacts {
  /** Asks for contacts permission if needed and lets the member pick one (M13). */
  pickOne(): Promise<ContactsResult>;
}

export interface Device {
  info: DeviceInfo;
  location: Location;
  clipboard: Clipboard;
  /** Absent on devices without a camera (the pay screens treat it as unavailable). */
  camera?: Camera;
  contacts?: Contacts;
}

export const DeviceContext = createContext<Device | undefined>(undefined);
export const DeviceProvider = DeviceContext.Provider;
export function useDevice(): Device {
  const d = useContext(DeviceContext);
  if (!d) throw new Error('DeviceProvider is missing');
  return d;
}

/** True when the OS can open an eSIM install link in one tap: iOS 17.4+ universal link, any Android (REQ-ESIM-001). */
export function supportsOneTapInstall(info: DeviceInfo): boolean {
  if (info.platform === 'android') return true;
  const [major = 0, minor = 0] = info.osVersion.split('.').map((n) => Number.parseInt(n, 10) || 0);
  return major > 17 || (major === 17 && minor >= 4);
}

export function fakeDevice(
  over: Partial<DeviceInfo> = {},
  location: LocationResult = { status: 'granted', position: { lat: 31.77, lng: 35.21, accuracyM: 12 } },
  extras: { scan?: ScanResult; contact?: ContactsResult } = {},
): Device & { copied: string[] } {
  const copied: string[] = [];
  return {
    info: { platform: 'ios', osVersion: '17.4', esimCapable: true, ...over },
    location: { requestOnce: async () => location },
    clipboard: { copy: async (t) => void copied.push(t) },
    ...(extras.scan ? { camera: { scanOnce: async () => extras.scan! } } : {}),
    ...(extras.contact ? { contacts: { pickOne: async () => extras.contact! } } : {}),
    copied,
  };
}
