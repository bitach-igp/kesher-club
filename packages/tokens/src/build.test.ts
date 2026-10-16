// T-0006: the Style Dictionary build produces every output and the CSS declares every token for
// both modes. Builds into a temp dir so it never depends on (or dirties) dist/.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTokens, collectLeaves, loadTokens, type BuildResult } from '../sd.config.mjs';

const kebab = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
const cssName = (segments: string[]) => `--${segments.map(kebab).join('-')}`;

/** Declarations inside one CSS block, found by its selector line. */
function block(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `block ${selector}`).toBeGreaterThanOrEqual(0);
  const end = css.indexOf('\n}', start);
  return css.slice(start, end);
}

let out: BuildResult;
let tmp: string;
let css: string;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kesher-tokens-'));
  out = await buildTokens({ outDir: tmp, generatedFile: null, silent: true });
  css = fs.readFileSync(out.files.css, 'utf8');
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const leaves = collectLeaves(loadTokens());
const colourLeaves = leaves.filter((l) => l.token.$type === 'color');
const sharedLeaves = leaves.filter((l) => l.token.$type !== 'color');

describe('build outputs', () => {
  it('writes all four files', () => {
    for (const f of Object.values(out.files)) expect(fs.existsSync(f), f).toBe(true);
    expect(path.relative(tmp, out.files.css)).toBe(path.join('css', 'tokens.css'));
    expect(path.relative(tmp, out.files.tailwind)).toBe(path.join('tailwind', 'preset.js'));
    expect(path.relative(tmp, out.files.native)).toBe(path.join('native', 'theme.ts'));
    expect(path.relative(tmp, out.files.json)).toBe(path.join('json', 'tokens.flat.json'));
  });

  it('the committed src/theme.generated.ts matches a fresh build (run `pnpm --filter @kesher/tokens build`)', () => {
    const committed = fs.readFileSync(new URL('./theme.generated.ts', import.meta.url), 'utf8');
    expect(committed).toBe(fs.readFileSync(out.files.native, 'utf8'));
  });
});

describe('dist/css/tokens.css', () => {
  it('declares every colour token in :root, [data-theme="dark"] and the prefers-color-scheme block', () => {
    const root = block(css, ':root');
    const manualDark = block(css, '[data-theme="dark"]');
    const systemDark = block(css, ':root:not([data-theme="light"])');
    expect(css).toContain('@media (prefers-color-scheme: dark)');
    for (const l of colourLeaves) {
      const name = cssName(l.path);
      expect(root, name).toMatch(new RegExp(`${name}: #[0-9A-F]{6,8};`));
      expect(manualDark, name).toMatch(new RegExp(`${name}: #[0-9A-F]{6,8};`));
      expect(systemDark, name).toMatch(new RegExp(`${name}: #[0-9A-F]{6,8};`));
    }
    expect(root).toContain('--color-bg-canvas: #FBF8F3;');
    expect(manualDark).toContain('--color-bg-canvas: #0E1523;');
    expect(manualDark).toContain('--color-money-in: #5CC98A;');
  });

  it('declares every mode-independent token once, in :root, with units', () => {
    const root = block(css, ':root');
    const manualDark = block(css, '[data-theme="dark"]');
    for (const l of sharedLeaves) {
      const name = cssName(l.path);
      if (l.token.$type === 'typography') {
        for (const prop of Object.keys(l.token.$value as object)) expect(root, name).toContain(`${name}-${kebab(prop)}: `);
      } else {
        expect(root, name).toContain(`${name}: `);
      }
      expect(manualDark, name).not.toContain(`${name}`);
    }
    expect(root).toContain('--space-4: 16px;');
    expect(root).toContain('--space-0: 0;');
    expect(root).toContain('--radius-lg: 16px;');
    expect(root).toContain('--motion-duration-fast: 120ms;');
    expect(root).toContain('--motion-easing-standard: cubic-bezier(0.2, 0, 0, 1);');
    expect(root).toContain('--elev-1: 0 1px 2px 0 #14233B0F, 0 1px 1px 0 #14233B0A;');
    expect(root).toContain('--typography-money-hero-font-feature-settings: "tnum";');
    expect(root).toContain('--typography-micro-letter-spacing: 0.04em;');
  });
});

describe('dist/tailwind/preset.js', () => {
  it('is an ESM preset with colours bound to the CSS variables plus spacing, radius, fontSize and shadows', async () => {
    const mod = (await import(pathToFileURL(out.files.tailwind).href)) as { default: { darkMode: unknown; theme: { extend: Record<string, Record<string, unknown>> } } };
    const ext = mod.default.theme.extend;
    expect(mod.default.darkMode).toEqual(['selector', '[data-theme="dark"]']);
    expect(ext.colors).toMatchObject({ bg: { canvas: 'var(--color-bg-canvas)' }, money: { in: 'var(--color-money-in)' } });
    expect(ext.spacing).toEqual({ '0': '0', '1': '4px', '2': '8px', '3': '12px', '4': '16px', '5': '20px', '6': '24px', '8': '32px', '10': '40px', '12': '48px', '16': '64px' });
    expect(ext.borderRadius).toMatchObject({ sm: '6px', md: '10px', lg: '16px', xl: '24px', full: '9999px' });
    expect(ext.fontSize).toMatchObject({ body: ['16px', { lineHeight: '24px', fontWeight: '400' }], 'money-hero': ['40px', { lineHeight: '44px', fontWeight: '700' }] });
    expect(ext.boxShadow).toMatchObject({ 'elev-2': '0 4px 12px 0 #14233B1A' });
  });
});

describe('dist/json/tokens.flat.json', () => {
  it('is a flat path -> token map with light and dark values for colours', () => {
    const flat = JSON.parse(fs.readFileSync(out.files.json, 'utf8')) as Record<string, { $type: string; $value: unknown; $description?: string }>;
    expect(Object.keys(flat).length).toBe(leaves.length);
    expect(flat['color.money.in']).toEqual({ $type: 'color', $description: expect.stringContaining('Alias of status.success'), $value: { light: '#177A45', dark: '#5CC98A' } });
    expect(flat['color.status.successSubtle']?.$value).toEqual({ light: '#ECF4F0', dark: '#223B41' });
    expect(flat['space.4']?.$value).toEqual({ value: 16, unit: 'px' });
    expect((flat['typography.moneyHero']?.$value as Record<string, unknown>).fontFeatureSettings).toBe('tnum');
    for (const key of Object.keys(flat)) expect(key.startsWith('light.') || key.startsWith('dark.'), key).toBe(false);
  });
});
