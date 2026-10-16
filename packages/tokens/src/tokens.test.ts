// T-0006: structural rules of the token set, checked on the source (tokens.json) and the generated
// theme so a hand edit to either is caught.
import { describe, expect, it } from 'vitest';
import { collectLeaves, expandModes, loadTokens, tint } from '../sd.config.mjs';
import { dark, light, theme } from './theme.generated.ts';

const source = loadTokens();
const leaves = collectLeaves(source);
const leaf = (path: string) => leaves.find((l) => l.path.join('.') === path);

describe('spacing scale', () => {
  it('is on a 4 px base: every space.* value is a multiple of 4', () => {
    const entries = Object.entries(light.space);
    expect(entries.length).toBe(11);
    for (const [key, value] of entries) {
      expect(Number.isInteger(value), `space.${key}`).toBe(true);
      expect(value % 4, `space.${key} = ${value}`).toBe(0);
      expect(value).toBe(Number(key) * 4);
    }
  });

  it('keeps gutters, card padding and section gap on the scale', () => {
    expect(light.layout.gutter.mobile).toBe(16);
    expect(light.layout.gutter.web).toBe(24);
    expect(light.layout.cardPadding).toBe(16);
    expect(light.layout.sectionGap).toBe(24);
  });
});

describe('money colour aliases', () => {
  it('money.in equals status.success in both modes', () => {
    expect(light.color.money.in).toBe(light.color.status.success);
    expect(dark.color.money.in).toBe(dark.color.status.success);
    expect(light.color.money.in).not.toBe(dark.color.money.in);
  });

  it('money.out equals text.primary in both modes', () => {
    expect(light.color.money.out).toBe(light.color.text.primary);
    expect(dark.color.money.out).toBe(dark.color.text.primary);
  });

  it('is an alias in the source, not a hand-copied hex', () => {
    expect(leaf('color.money.in')?.token.$value).toBe('{color.status.success}');
    expect(leaf('color.money.out')?.token.$value).toBe('{color.text.primary}');
  });
});

describe('status subtle tints', () => {
  it('are references plus an alpha in the source and computed by the build (8% light, 16% dark)', () => {
    for (const status of ['success', 'warning', 'danger'] as const) {
      const src = leaf(`color.status.${status}Subtle`)?.token;
      expect(src?.$value).toEqual({ color: `{color.status.${status}}`, on: '{color.bg.surface}', alpha: 0.08 });
      expect(light.color.status[`${status}Subtle`]).toBe(tint(light.color.status[status], light.color.bg.surface, 0.08));
      expect(dark.color.status[`${status}Subtle`]).toBe(tint(dark.color.status[status], dark.color.bg.surface, 0.16));
    }
  });

  it('tint() composites linearly in sRGB', () => {
    expect(tint('#000000', '#FFFFFF', 0.5)).toBe('#808080');
    expect(tint('#177A45', '#FFFFFF', 0)).toBe('#FFFFFF');
    expect(tint('#177A45', '#FFFFFF', 1)).toBe('#177A45');
  });
});

describe('typography', () => {
  it('sets tabular figures on the money hero token (fontFeatureSettings: "tnum")', () => {
    const hero = leaf('typography.moneyHero')?.token.$value as Record<string, unknown>;
    expect(hero.fontFeatureSettings).toBe('tnum');
    expect(hero.fontSize).toEqual({ value: 40, unit: 'px' });
    expect(hero.lineHeight).toEqual({ value: 44, unit: 'px' });
    expect(hero.fontWeight).toBe('{font.weight.bold}');
    // The React Native theme carries the same intent as fontVariant.
    expect(light.typography.moneyHero.fontVariant).toEqual(['tabular-nums']);
    expect(light.typography.moneyHero.fontWeight).toBe('700');
  });

  it('sets the currency symbol at 60% of the hero size, baseline-aligned (same line height)', () => {
    expect(light.typography.moneyHeroSymbol.fontSize).toBe(light.typography.moneyHero.fontSize * 0.6);
    expect(light.typography.moneyHeroSymbol.lineHeight).toBe(light.typography.moneyHero.lineHeight);
    expect(light.typography.moneyHeroSymbol.fontVariant).toEqual(['tabular-nums']);
  });

  it('follows the spec scale and keeps 13 px as the minimum text size (micro is for labels only)', () => {
    const scale: Array<[keyof typeof light.typography, number, number, string]> = [
      ['display', 32, 40, '700'],
      ['title1', 24, 32, '700'],
      ['title2', 20, 28, '600'],
      ['headline', 17, 24, '600'],
      ['body', 16, 24, '400'],
      ['callout', 15, 22, '400'],
      ['caption', 13, 18, '500'],
      ['micro', 11, 14, '600'],
    ];
    for (const [name, size, lineHeight, weight] of scale) {
      const t = light.typography[name];
      expect([t.fontSize, t.lineHeight, t.fontWeight], name).toEqual([size, lineHeight, weight]);
    }
    expect(light.typography.micro.textTransform).toBe('uppercase');
    expect(light.typography.micro.letterSpacing).toBeCloseTo(0.44, 2); // 4% of 11 px
    expect(light.font.family.latin).toBe('Inter');
    expect(light.font.family.hebrew).toBe('Rubik');
  });
});

describe('modes', () => {
  it('every colour token has a dark value; nothing else is moded', () => {
    const colours = leaves.filter((l) => l.token.$type === 'color');
    expect(colours.length).toBeGreaterThan(20);
    for (const l of colours) {
      const modes = l.token.$extensions?.['club.kesher.modes'] as { dark?: unknown } | undefined;
      const isAlias = typeof l.token.$value === 'string' && l.token.$value.startsWith('{');
      expect(isAlias || modes?.dark !== undefined, `${l.path.join('.')} needs a dark value`).toBe(true);
    }
    for (const l of leaves.filter((l) => l.token.$type !== 'color')) {
      expect(l.token.$extensions?.['club.kesher.modes'], l.path.join('.')).toBeUndefined();
    }
  });

  it('expandModes() clones colours under light.* and dark.* and rewrites references per mode', () => {
    const expanded = expandModes(source) as Record<string, Record<string, Record<string, Record<string, { $value: unknown }>>>>;
    expect(expanded.light?.color?.money?.in?.$value).toBe('{light.color.status.success}');
    expect(expanded.dark?.color?.money?.in?.$value).toBe('{dark.color.status.success}');
    expect(expanded.dark?.color?.bg?.canvas?.$value).toBe('#0E1523');
    expect(expanded.color).toBeUndefined();
    expect(expanded.space).toBeDefined();
  });

  it('light and dark share one shape and only colours differ', () => {
    expect(Object.keys(theme)).toEqual(['light', 'dark']);
    const { color: _lc, ...lightRest } = light;
    const { color: _dc, ...darkRest } = dark;
    expect(darkRest).toEqual(lightRest);
    expect(dark.color).not.toEqual(light.color);
  });

  it('radius, motion and icon tokens match the spec', () => {
    expect(light.radius).toEqual({ sm: 6, md: 10, lg: 16, xl: 24, full: 9999, card: 12 });
    expect(light.motion.duration).toEqual({ fast: 120, base: 200, slow: 320, signature: 900 });
    expect(light.motion.easing.standard).toEqual([0.2, 0, 0, 1]);
    expect(light.motion.easing.exit).toEqual([0.3, 0, 1, 1]);
    expect(light.icon.size).toEqual({ sm: 16, md: 20, lg: 24 });
    expect(light.elev[1].shadowOpacity).toBe(0.06);
    expect(light.elev[3].shadowOffset).toEqual({ width: 0, height: 12 });
  });
});
