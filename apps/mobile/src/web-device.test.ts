// T-0528: the web build's device binding. A phone's browser reports its own platform and OS version, so the
// eSIM steps and the one-tap rule follow the phone; a desktop browser cannot hold an eSIM; location maps the
// browser's answers (a denial is `denied`, a missing API or a timeout is `unavailable`); the clipboard writes.
import { describe, expect, it, vi } from 'vitest';
import { supportsOneTapInstall } from './device.ts';
import { webDevice, webDeviceInfo } from './web-device.ts';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
const PIXEL = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';
const DESKTOP = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0 Safari/537.36';

describe('web device binding (T-0528)', () => {
  it('reads the platform from the user agent: iPhone 17.4 gets one tap, a desktop browser no eSIM', () => {
    expect(webDeviceInfo(IPHONE)).toEqual({ platform: 'ios', osVersion: '17.4', esimCapable: true });
    expect(supportsOneTapInstall(webDeviceInfo(IPHONE))).toBe(true);
    expect(supportsOneTapInstall(webDeviceInfo(IPHONE.replace('17_4', '16_7')))).toBe(false);
    expect(webDeviceInfo(PIXEL)).toEqual({ platform: 'android', osVersion: '14', esimCapable: true });
    expect(webDeviceInfo(DESKTOP)).toEqual({ platform: 'web', osVersion: '0', esimCapable: false });
    expect(supportsOneTapInstall(webDeviceInfo(DESKTOP))).toBe(false);
    expect(webDevice(undefined).info.platform).toBe('web');
  });

  it('location: a fix is granted, a refusal is denied, a timeout or a browser without it is unavailable', async () => {
    const fix = { getCurrentPosition: (ok: PositionCallback) => ok({ coords: { latitude: 31.77, longitude: 35.21, accuracy: 12 } } as GeolocationPosition) };
    expect(await webDevice({ geolocation: fix }).location.requestOnce()).toEqual({ status: 'granted', position: { lat: 31.77, lng: 35.21, accuracyM: 12 } });
    const refuse = (code: number) => ({ getCurrentPosition: (_ok: PositionCallback, fail?: PositionErrorCallback | null) => fail?.({ code } as GeolocationPositionError) });
    expect(await webDevice({ geolocation: refuse(1) }).location.requestOnce()).toEqual({ status: 'denied' });
    expect(await webDevice({ geolocation: refuse(3) }).location.requestOnce()).toEqual({ status: 'unavailable' });
    expect(await webDevice({}).location.requestOnce()).toEqual({ status: 'unavailable' });
  });

  it('the clipboard writes through the browser, and says so when there is none; no camera or contacts on web', async () => {
    const writeText = vi.fn(async () => undefined);
    const d = webDevice({ clipboard: { writeText } });
    await d.clipboard.copy('LPA:1$smdp.example$CODE');
    expect(writeText).toHaveBeenCalledWith('LPA:1$smdp.example$CODE');
    await expect(webDevice({}).clipboard.copy('x')).rejects.toThrow(/not available/);
    expect([d.camera, d.contacts]).toEqual([undefined, undefined]);
  });
});
