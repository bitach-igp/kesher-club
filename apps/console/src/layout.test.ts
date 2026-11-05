// T-0675: the console shell's styles come from the tokens, not from a template of literals in the layout. layout.tsx
// imports the generated token variables and `app/styles.css`; the stylesheet holds the classes (status pills, table, stat
// tile, form fields) and reaches colour, spacing and radius only through `var(--token)`, every one of which the tokens'
// generated CSS defines (or the stylesheet defines itself as an alias). `lang` and `dir` stay set on <html>.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => fs.readFileSync(path.resolve(here, rel), 'utf8');
const layout = read('../app/layout.tsx');
const styles = read('../app/styles.css');
const tokens = read('../../../packages/tokens/dist/css/tokens.css');

describe('console layout styles (T-0675)', () => {
  it('layout.tsx carries no inline stylesheet and no colour literal; it imports the token variables and the stylesheet', () => {
    expect(layout).not.toMatch(/<style\b/);
    expect(layout).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
    expect(layout).not.toMatch(/\b(padding|margin|font|background|border):/);
    expect(layout).toMatch(/import '@kesher\/tokens\/css';/);
    expect(layout).toMatch(/import '\.\/styles\.css';/);
  });

  it('keeps lang and dir on <html>', () => {
    expect(layout).toMatch(/<html lang=\{locale\} dir=\{dirOf\(locale\)\}>/);
  });

  it('the stylesheet has no colour literal: every colour is a token variable', () => {
    expect(styles).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
  });

  it('every variable the stylesheet reads is defined by the tokens or by the stylesheet itself', () => {
    const used = [...styles.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]!);
    expect(used.length).toBeGreaterThan(20);
    const defined = new Set([...tokens.matchAll(/(--[a-z0-9-]+)\s*:/g), ...styles.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]!));
    expect(used.filter((v) => !defined.has(v))).toEqual([]);
  });

  it('defines the shared classes: status pills, table, stat tile, form fields, and a visible focus ring', () => {
    for (const cls of ['.pill', '.pill.ok', '.pill.warn', '.pill.bad', '.table', '.stats', '.stat', '.field']) expect(styles, cls).toContain(cls);
    expect(styles).toMatch(/:focus-visible/);
    expect(styles).toMatch(/max-width:\s*min\(/);
  });

  it('keeps the classes the pages already use', () => {
    for (const cls of ['.banner', '.card', '.muted', '.error', '.row', 'button.primary']) expect(styles, cls).toContain(cls);
  });
});
