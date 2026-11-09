// Builds the real static site against a fixture legal API (T-0048) and checks what it wrote. Each `next build` takes a few seconds.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_IDS } from './app-ids.ts';
import { buildFixture, fixtureItems, type FixtureBuild } from './build-fixture.ts';
import { DOC_KEYS } from './legal.ts';
import { auditCss, auditHtml } from './static-audit.ts';

const HOSTILE = 'Intro\n<script>alert(1)</script> <img src=x onerror=alert(2)> **bold** [link](https://evil.test) &amp; "quoted"';
const builds: FixtureBuild[] = [];
const track = (b: FixtureBuild) => (builds.push(b), b);
afterAll(() => builds.forEach((b) => b.cleanup()));

describe('the static site, built from a fixture legal API', () => {
  let site: FixtureBuild;
  beforeAll(async () => {
    site = track(await buildFixture({ items: fixtureItems({ termsBody: HOSTILE }) }));
  }, 240_000);

  it('builds, with one page per legal kind plus the landing, support and legal index pages', () => {
    expect(site.code, site.output).toBe(0);
    for (const f of ['index.html', 'support.html', 'legal.html', ...DOC_KEYS.map((k) => `legal/${k}.html`)]) expect(site.files, f).toContain(f);
  });

  it('renders a document body as escaped plain text: nothing in it becomes markup', () => {
    const html = site.read('legal/terms.html');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(2)&gt;');
    expect(html).toContain('**bold** [link](https://evil.test)');
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('<img');
    expect(html).not.toMatch(/<a [^>]*evil\.test/);
  });

  it('carries both languages in every legal page, each with its own lang and dir, and a default of English left to right', () => {
    const html = site.read('legal/terms.html');
    expect(html).toMatch(/^<!DOCTYPE html><html lang="en" dir="ltr"/);
    expect(html).toContain('<section lang="en" dir="ltr"');
    expect(html).toContain('<section lang="he" dir="rtl"');
    expect(html).toContain('terms title');
    expect(html).toContain('terms כותרת');
    expect(html).toContain('גוף terms.');
    expect(html).toContain('hash-terms');
    expect(html).toContain('2026-03-04');
    // the language switch the mobile link shape relies on: same-origin script, no inline code needed
    expect(html).toContain('<script src="/lang.js">');
    expect(site.read('lang.js')).toContain("get('lang')");
  });

  it('answers the mobile link shape /legal/<docKey>?lang=<locale> with a page that exists for every kind', () => {
    for (const k of DOC_KEYS) expect(site.read(`legal/${k}.html`)).toContain(`hash-${k}`);
    const index = site.read('legal.html');
    for (const k of DOC_KEYS) for (const lang of ['en', 'he']) expect(index).toContain(`href="/legal/${k}?lang=${lang}"`);
  });

  it('landing and support are bilingual, link to support, and take the address from the config constant', () => {
    const landing = site.read('index.html');
    expect(landing).toContain('<section lang="he" dir="rtl"');
    expect(landing).toContain('href="/support"');
    expect(site.read('support.html')).toMatch(/href="mailto:support@PLACEHOLDER[^"]*"/);
  });

  it('the two association files parse as JSON and name the ids of the one config module', () => {
    const aasa = JSON.parse(site.read('.well-known/apple-app-site-association')) as { webcredentials: { apps: string[] }; applinks: { details: { appIDs: string[] }[] } };
    const appId = `${APP_IDS.appleTeamId}.${APP_IDS.iosBundleId}`;
    expect(aasa.webcredentials.apps).toEqual([appId]);
    expect(aasa.applinks.details[0]?.appIDs).toEqual([appId]);
    const links = JSON.parse(site.read('.well-known/assetlinks.json')) as { target: { package_name: string; sha256_cert_fingerprints: string[] } }[];
    expect(links[0]?.target.package_name).toBe(APP_IDS.androidPackage);
    expect(links[0]?.target.sha256_cert_fingerprints).toEqual([...APP_IDS.androidCertSha256]);
  });

  it('a local build without STRIPE_APPLE_PAY_DOMAIN_FILE writes no Stripe file', () => {
    expect(site.files.some((f) => f.includes('apple-developer-merchantid-domain-association'))).toBe(false);
  });

  it('loads nothing from a third party: no external script, style, font, frame or image, and no inline event handler', () => {
    const pages = site.files.filter((f) => f.endsWith('.html') && !f.startsWith('server/') && !f.startsWith('cache/'));
    expect(pages.length).toBeGreaterThanOrEqual(10);
    const offences = pages.flatMap((f) => auditHtml(site.read(f), f));
    const sheets = site.files.filter((f) => f.startsWith('_next/static/') && f.endsWith('.css'));
    expect(sheets.length).toBeGreaterThan(0);
    offences.push(...sheets.flatMap((f) => auditCss(site.read(f), f)));
    expect(offences).toEqual([]);
  });
});

describe('builds that must fail', () => {
  it('fails closed when a legal kind has no published version, and writes no site', async () => {
    const b = track(await buildFixture({ items: fixtureItems({ omit: ['insurance'] }) }));
    expect(b.code).not.toBe(0);
    expect(b.output).toContain('no published version for: insurance');
    expect(b.files.filter((f) => f.endsWith('.html') && !f.includes('/'))).toEqual([]);
  }, 240_000);

  it('fails closed when the legal API cannot be fetched', async () => {
    const b = track(await buildFixture({ env: { LEGAL_API_URL: 'http://127.0.0.1:9/v1' } }));
    expect(b.code).not.toBe(0);
    expect(b.output).toContain('the legal API could not be reached');
  }, 240_000);

  it('a production build with the placeholders stops before rendering, naming the keys', async () => {
    const b = track(await buildFixture({ env: { WEB_ENV: 'production' }, stripeFile: 'blob' }));
    expect(b.code).not.toBe(0);
    expect(b.output).toContain('app id iosBundleId');
    expect(b.output).toContain('SUPPORT_EMAIL');
    expect(b.files.filter((f) => f.endsWith('.html'))).toEqual([]);
  }, 240_000);

  it('a production build without the Stripe file stops, and with it the file is published as given', async () => {
    const missing = track(await buildFixture({ env: { WEB_ENV: 'production' } }));
    expect(missing.output).toContain('STRIPE_APPLE_PAY_DOMAIN_FILE is required');
    const local = track(await buildFixture({ stripeFile: 'opaque-blob-from-stripe\n' }));
    expect(local.code, local.output).toBe(0);
    expect(local.read('.well-known/apple-developer-merchantid-domain-association')).toBe('opaque-blob-from-stripe\n');
  }, 240_000);
});
