// The device binding for the web build (T-0528): what a browser can honestly say about itself. The platform
// and OS version come from the user agent, so a phone's browser still gets its own install steps; a desktop
// browser is `web`, cannot hold an eSIM, and has no one-tap install. Location and clipboard are the browser's
// own APIs; a browser without them answers `unavailable` rather than throwing. Camera scanning and the contact
// picker are left out, and the pay screens already treat them as unavailable. The native build binds
// expo-location, expo-clipboard and the rest when those modules are added.
import type { Device, DeviceInfo, LocationResult } from './device.ts';

/** The browser APIs this binding reads; injected so tests need no browser. */
export interface BrowserNavigator {
  userAgent?: string | undefined;
  geolocation?: Pick<Geolocation, 'getCurrentPosition'> | undefined;
  clipboard?: Pick<Clipboard, 'writeText'> | undefined;
}

const LOCATION_TIMEOUT_MS = 15_000;

export function webDeviceInfo(userAgent: string): DeviceInfo {
  const ios = /\b(?:iPhone|iPad|iPod)\b.*?OS (\d+)[_.](\d+)/.exec(userAgent);
  if (ios) return { platform: 'ios', osVersion: `${ios[1]}.${ios[2]}`, esimCapable: true };
  const android = /\bAndroid (\d+(?:\.\d+)?)/.exec(userAgent);
  if (android) return { platform: 'android', osVersion: android[1]!, esimCapable: true };
  return { platform: 'web', osVersion: '0', esimCapable: false };
}

export function webDevice(nav: BrowserNavigator | undefined): Device {
  return {
    info: webDeviceInfo(nav?.userAgent ?? ''),
    location: {
      requestOnce: () =>
        new Promise<LocationResult>((resolve) => {
          const geo = nav?.geolocation;
          if (!geo) return resolve({ status: 'unavailable' });
          geo.getCurrentPosition(
            (p) => resolve({ status: 'granted', position: { lat: p.coords.latitude, lng: p.coords.longitude, accuracyM: p.coords.accuracy } }),
            // 1 is PERMISSION_DENIED; a timeout or no fix is unavailable, so the screen can say so.
            (e) => resolve(e.code === 1 ? { status: 'denied' } : { status: 'unavailable' }),
            { enableHighAccuracy: true, timeout: LOCATION_TIMEOUT_MS, maximumAge: 0 },
          );
        }),
    },
    clipboard: {
      copy: async (text) => {
        if (!nav?.clipboard) throw new Error('Clipboard is not available in this browser');
        await nav.clipboard.writeText(text);
      },
    },
  };
}
