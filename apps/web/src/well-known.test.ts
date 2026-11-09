import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_IDS, appIdProblems, type AppIds } from './app-ids.ts';
import { loadBuildConfig, SiteConfigError, SUPPORT_EMAIL } from './site-config.ts';
import { renderAppleAppSiteAssociation, renderAssetLinks } from './well-known.ts';

// Fixture values for the format checks only; they are not the app's ids (T-0058 owns those).
const FINGERPRINT = Array.from({ length: 32 }, (_, i) => i.toString(16).toUpperCase().padStart(2, '0')).join(':');
const REAL_LOOKING: AppIds = { iosBundleId: 'test.fixture.club', appleTeamId: 'ABCDE12345', androidPackage: 'test.fixture.club', androidCertSha256: [FINGERPRINT] };
const GOOD = { WEB_ENV: 'production', LEGAL_API_URL: 'https://api.example.test/v1' };

describe('the domain-association files come from the one ids module (T-0048)', () => {
  it('apple-app-site-association round-trips as JSON and names the ids for webcredentials and applinks', () => {
    const parsed = JSON.parse(JSON.stringify(renderAppleAppSiteAssociation(APP_IDS))) as {
      webcredentials: { apps: string[] };
      applinks: { details: { appIDs: string[] }[] };
    };
    const appId = `${APP_IDS.appleTeamId}.${APP_IDS.iosBundleId}`;
    expect(parsed.webcredentials.apps).toEqual([appId]);
    expect(parsed.applinks.details[0]?.appIDs).toEqual([appId]);
  });

  it('keeps the marketing and legal pages out of the app (the app links them into the browser)', () => {
    const text = JSON.stringify(renderAppleAppSiteAssociation(REAL_LOOKING));
    expect(text).toContain('ABCDE12345.test.fixture.club');
    for (const p of ['/', '/support', '/legal/*']) expect(text).toContain(`{"/":"${p}","exclude":true}`);
  });

  it('assetlinks.json grants links and credentials to the Android package and fingerprint', () => {
    const parsed = JSON.parse(JSON.stringify(renderAssetLinks(APP_IDS))) as {
      relation: string[];
      target: { namespace: string; package_name: string; sha256_cert_fingerprints: string[] };
    }[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.relation).toEqual(['delegate_permission/common.handle_all_urls', 'delegate_permission/common.get_login_creds']);
    expect(parsed[0]?.target).toEqual({ namespace: 'android_app', package_name: APP_IDS.androidPackage, sha256_cert_fingerprints: [...APP_IDS.androidCertSha256] });
  });

  it('every id in the module is still a placeholder until T-0058 sets it', () => {
    expect(appIdProblems(APP_IDS).sort()).toEqual(['androidCertSha256', 'androidPackage', 'appleTeamId', 'iosBundleId']);
    expect(appIdProblems(REAL_LOOKING)).toEqual([]);
  });

  it('flags a malformed team id or fingerprint, not only a placeholder', () => {
    expect(appIdProblems({ ...REAL_LOOKING, appleTeamId: 'abc' })).toEqual(['appleTeamId']);
    expect(appIdProblems({ ...REAL_LOOKING, androidCertSha256: ['AB:CD'] })).toEqual(['androidCertSha256']);
    expect(appIdProblems({ ...REAL_LOOKING, androidCertSha256: [] })).toEqual(['androidCertSha256']);
    expect(appIdProblems({ ...REAL_LOOKING, iosBundleId: 'nodots' })).toEqual(['iosBundleId']);
  });
});

describe('build configuration (T-0048)', () => {
  const ok = { appIds: REAL_LOOKING, supportEmail: 'help@example.test' };

  it('a local build passes with the placeholders in place', () => {
    expect(loadBuildConfig({ WEB_ENV: 'local', LEGAL_API_URL: 'http://127.0.0.1:1/v1' }).webEnv).toBe('local');
    expect(SUPPORT_EMAIL).toContain('PLACEHOLDER');
  });

  it('a production build refuses the placeholders, naming the keys and no values', () => {
    const run = () => loadBuildConfig(GOOD);
    expect(run).toThrow(SiteConfigError);
    try {
      run();
    } catch (e) {
      const text = (e as SiteConfigError).problems.join('\n');
      for (const field of ['iosBundleId', 'appleTeamId', 'androidPackage', 'androidCertSha256']) expect(text).toContain(field);
      expect(text).toContain('SUPPORT_EMAIL');
      expect(text).not.toContain('T0058_APPLE_TEAM_ID');
    }
  });

  it('staging needs real ids too, but not the Stripe file', () => {
    expect(() => loadBuildConfig({ ...GOOD, WEB_ENV: 'staging' })).toThrow(/app id iosBundleId/);
    expect(loadBuildConfig({ ...GOOD, WEB_ENV: 'staging' }, ok).stripeApplePayFile).toBeUndefined();
  });

  it('production requires the Stripe domain file, and a real one', () => {
    expect(() => loadBuildConfig(GOOD, ok)).toThrow(/STRIPE_APPLE_PAY_DOMAIN_FILE is required/);
    expect(() => loadBuildConfig({ ...GOOD, STRIPE_APPLE_PAY_DOMAIN_FILE: '/nonexistent/file' }, ok)).toThrow(/cannot be read/);
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'kesher-web-')), 'blob');
    writeFileSync(file, 'opaque-domain-association-blob');
    expect(loadBuildConfig({ ...GOOD, STRIPE_APPLE_PAY_DOMAIN_FILE: file }, ok).stripeApplePayFile).toBe('opaque-domain-association-blob');
    writeFileSync(file, '  \n');
    expect(() => loadBuildConfig({ ...GOOD, STRIPE_APPLE_PAY_DOMAIN_FILE: file }, ok)).toThrow(/empty file/);
  });

  it('a missing or odd environment crashes, and so does a missing or insecure API URL', () => {
    expect(() => loadBuildConfig({ LEGAL_API_URL: 'https://x.test' })).toThrow(/WEB_ENV/);
    expect(() => loadBuildConfig({ WEB_ENV: 'prod', LEGAL_API_URL: 'https://x.test' })).toThrow(/WEB_ENV/);
    expect(() => loadBuildConfig({ WEB_ENV: 'local' })).toThrow(/LEGAL_API_URL is required/);
    expect(() => loadBuildConfig({ WEB_ENV: 'local', LEGAL_API_URL: 'not a url' })).toThrow(/not a URL/);
    expect(() => loadBuildConfig({ WEB_ENV: 'staging', LEGAL_API_URL: 'http://api.example.test/v1' }, ok)).toThrow(/must be https/);
    expect(() => loadBuildConfig({ WEB_ENV: 'staging', LEGAL_API_URL: 'https://localhost/v1' }, ok)).toThrow(/loopback/);
  });

  it('refuses a malformed support address', () => {
    expect(() => loadBuildConfig({ WEB_ENV: 'staging', LEGAL_API_URL: 'https://x.test/v1' }, { ...ok, supportEmail: 'not-an-address' })).toThrow(/SUPPORT_EMAIL/);
  });
});
