// The one place the native app's identity is written down (T-0048). The two domain-association files are rendered from this module
// (`src/well-known.ts`) and nothing else, and the build refuses a staging or production site that still holds a placeholder
// (`src/site-config.ts`).
//
// EVERY VALUE BELOW IS A PLACEHOLDER. T-0058 (mobile release plumbing) owns the real bundle id, Android package, Apple Team ID and the
// SHA-256 fingerprint(s) of the Android signing certificate(s); it must change this file, and only this file, on the web side. None
// of them is guessed here: an invented Team ID or fingerprint would make passkeys and universal links fail silently on a real device.
export const PLACEHOLDER = 'PLACEHOLDER';

export interface AppIds {
  /** iOS bundle identifier, reverse-DNS (`ios.bundleIdentifier` in apps/mobile/app.json, T-0058). */
  iosBundleId: string;
  /** Apple Developer Team ID: ten upper-case letters and digits. */
  appleTeamId: string;
  /** Android application id (`android.package`, T-0058). */
  androidPackage: string;
  /** SHA-256 fingerprint(s) of the signing certificate(s) (Play App Signing key, plus the upload key while testing): `AA:BB:...` x 32. */
  androidCertSha256: readonly string[];
}

export const APP_IDS: AppIds = {
  iosBundleId: 'PLACEHOLDER.T-0058.ios-bundle-id',
  appleTeamId: 'PLACEHOLDER_T0058_APPLE_TEAM_ID',
  androidPackage: 'PLACEHOLDER.T-0058.android-package',
  androidCertSha256: ['PLACEHOLDER_T0058_ANDROID_CERT_SHA256'],
};

const REVERSE_DNS = /^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z][A-Za-z0-9-]*)+$/;
const TEAM_ID = /^[A-Z0-9]{10}$/;
const SHA256_FINGERPRINT = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;

/** What is wrong with the ids, by field name (never a value). Empty means they look real and may go on a staging or production site. */
export function appIdProblems(ids: AppIds): string[] {
  const out: string[] = [];
  const placeholder = (v: string) => v.includes(PLACEHOLDER);
  if (placeholder(ids.iosBundleId) || !REVERSE_DNS.test(ids.iosBundleId)) out.push('iosBundleId');
  if (placeholder(ids.appleTeamId) || !TEAM_ID.test(ids.appleTeamId)) out.push('appleTeamId');
  if (placeholder(ids.androidPackage) || !REVERSE_DNS.test(ids.androidPackage)) out.push('androidPackage');
  if (ids.androidCertSha256.length === 0 || ids.androidCertSha256.some((f) => placeholder(f) || !SHA256_FINGERPRINT.test(f))) out.push('androidCertSha256');
  return out;
}
