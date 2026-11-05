// T-0677: the admin shell shares the console's look. The areas live in one list (nav.ts), the layout imports the token
// variables and a stylesheet instead of building CSS from literals, and the home tiles use the shared stat classes. These
// are source and data checks (the admin tests are logic tests; they do not render pages).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AREAS, areaLabel } from './nav.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => fs.readFileSync(path.resolve(here, rel), 'utf8');
const layout = read('../../app/layout.tsx');
const styles = read('../../app/styles.css');
const home = read('../../app/page.tsx');
const tokens = read('../../../../packages/tokens/dist/css/tokens.css');

describe('admin navigation (T-0677)', () => {
  it('lists the areas once, each with a unique code, a label and an absolute href', () => {
    expect(AREAS.map((a) => a.code)).toEqual(['A01', 'A02', 'A03', 'A04', 'A05', 'A06', 'A07', 'A08', 'A09', 'A12']);
    expect(new Set(AREAS.map((a) => a.href)).size).toBe(AREAS.length);
    for (const a of AREAS) {
      expect(a.label.length).toBeGreaterThan(2);
      expect(a.href.startsWith('/')).toBe(true);
    }
    expect(areaLabel('A01')).toBe('Customer 360');
    expect(areaLabel('A99')).toBeUndefined();
  });
});

describe('admin shell styles (T-0677)', () => {
  it('the layout builds no stylesheet and has no colour literal; it imports the token variables, the stylesheet and the area list', () => {
    expect(layout).not.toMatch(/<style\b/);
    expect(layout).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
    expect(layout).toMatch(/import '@kesher\/tokens\/css';/);
    expect(layout).toMatch(/import '\.\/styles\.css';/);
    expect(layout).toMatch(/from '\.\.\/src\/ui\/nav\.ts'/);
  });

  it('the stylesheet reads only token variables, defines every one it reads, and keeps the classes the pages use', () => {
    expect(styles).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
    const used = [...styles.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]!);
    const defined = new Set([...tokens.matchAll(/(--[a-z0-9-]+)\s*:/g), ...styles.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]!));
    expect(used.length).toBeGreaterThan(20);
    expect(used.filter((v) => !defined.has(v))).toEqual([]);
    for (const cls of ['.shell', '.banner', '.tag', '.tag.red', '.tag.amber', '.tag.green', '.button', 'button.primary', 'button.danger', '.card', '.grid', '.muted', 'form.inline', '.stats', '.stat', ':focus-visible']) expect(styles, cls).toContain(cls);
  });

  it('the home page shows its counts as stat tiles', () => {
    expect(home).toMatch(/className="stats"/);
    expect(home.match(/className="stat"/g)?.length).toBe(3);
  });
});
