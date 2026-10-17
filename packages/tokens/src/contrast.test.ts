// T-0006: every colour pair the design spec (Tab 2) lists with a measured contrast ratio must meet
// the ratio it claims, computed with a real WCAG 2.1 relative-luminance function (./contrast.ts).
// Spec colours are never adjusted here; a failing row is a spec discrepancy to report.
import { describe, expect, it } from 'vitest';
import { contrastRatio, meetsContrast, relativeLuminance, WCAG_AA_NON_TEXT, WCAG_AA_TEXT } from './contrast.ts';
import { dark, light, type Theme } from './theme.generated.ts';

const modes: ReadonlyArray<readonly [string, Theme]> = [
  ['light', light],
  ['dark', dark],
];

/** Pairs with the ratio the spec claims per mode (light, dark) and the AA threshold that applies. */
const specPairs: ReadonlyArray<{
  name: string;
  fg: (t: Theme) => string;
  bg: (t: Theme) => string;
  claimed: readonly [number, number];
  minimum: number;
}> = [
  { name: 'text.primary on bg.canvas', fg: (t) => t.color.text.primary, bg: (t) => t.color.bg.canvas, claimed: [14.87, 16.14], minimum: WCAG_AA_TEXT },
  { name: 'text.secondary on bg.canvas', fg: (t) => t.color.text.secondary, bg: (t) => t.color.bg.canvas, claimed: [5.79, 8.1], minimum: WCAG_AA_TEXT },
  { name: 'text.onAction on action.primary', fg: (t) => t.color.text.onAction, bg: (t) => t.color.action.primary, claimed: [5.93, 7.78], minimum: WCAG_AA_TEXT },
  { name: 'status.success on bg.surface', fg: (t) => t.color.status.success, bg: (t) => t.color.bg.surface, claimed: [5.38, 7.88], minimum: WCAG_AA_TEXT },
  { name: 'status.warning on bg.surface', fg: (t) => t.color.status.warning, bg: (t) => t.color.bg.surface, claimed: [5.17, 8.88], minimum: WCAG_AA_TEXT },
  { name: 'status.danger on bg.surface', fg: (t) => t.color.status.danger, bg: (t) => t.color.bg.surface, claimed: [5.52, 7.13], minimum: WCAG_AA_TEXT },
];

describe('WCAG helpers', () => {
  it('black on white is 21:1 and a colour on itself is 1:1', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#FFFFFF', '#000000')).toBeCloseTo(21, 5);
    expect(contrastRatio('#1E5BD8', '#1E5BD8')).toBe(1);
  });

  it('matches the WCAG reference luminance for sRGB primaries', () => {
    expect(relativeLuminance('#FF0000')).toBeCloseTo(0.2126, 4);
    expect(relativeLuminance('#00FF00')).toBeCloseTo(0.7152, 4);
    expect(relativeLuminance('#0000FF')).toBeCloseTo(0.0722, 4);
    expect(relativeLuminance('#808080')).toBeCloseTo(0.2159, 3);
  });

  it('rejects anything that is not a hex colour', () => {
    expect(() => contrastRatio('rgb(0,0,0)', '#FFFFFF')).toThrow(/expected #RRGGBB/);
  });
});

describe('spec contrast claims (Tab 2 colour table)', () => {
  for (const pair of specPairs) {
    for (const [i, [mode, theme]] of modes.entries()) {
      const claimed = pair.claimed[i]!;
      it(`${pair.name} (${mode}) is >= ${pair.minimum}:1 and >= the claimed ${claimed}:1`, () => {
        const ratio = contrastRatio(pair.fg(theme), pair.bg(theme));
        expect(ratio).toBeGreaterThanOrEqual(pair.minimum);
        // The spec rounds to two decimals; allow only that rounding.
        expect(ratio).toBeGreaterThanOrEqual(claimed - 0.005);
        expect(meetsContrast(pair.fg(theme), pair.bg(theme), pair.minimum)).toBe(true);
      });
    }
  }

  it('action.primary on white is 5.93:1 (light)', () => {
    expect(contrastRatio(light.color.action.primary, '#FFFFFF')).toBeGreaterThanOrEqual(5.93 - 0.005);
  });

  it('ink on stone is 10.97:1 (light)', () => {
    expect(contrastRatio(light.color.text.primary, light.color.bg.stone)).toBeGreaterThanOrEqual(10.97 - 0.005);
  });

  it('accent.gold is 3.72:1 on surface (light, non-text use only)', () => {
    expect(contrastRatio(light.color.accent.gold, light.color.bg.surface)).toBeGreaterThanOrEqual(3.72 - 0.005);
    expect(meetsContrast(light.color.accent.gold, light.color.bg.surface, WCAG_AA_NON_TEXT)).toBe(true);
  });

  it('border.strong is 3.06:1 on surface in light; the spec gives no separate dark figure', () => {
    expect(contrastRatio(light.color.border.strong, light.color.bg.surface)).toBeGreaterThanOrEqual(3.06 - 0.005);
    // Reported discrepancy, not a token change: the dark value (#5D677B) reaches 3:1 only on
    // bg.canvas (3.21:1), not on bg.surface (2.86:1). Pinned so a future fix is a deliberate edit.
    expect(contrastRatio(dark.color.border.strong, dark.color.bg.canvas)).toBeGreaterThanOrEqual(WCAG_AA_NON_TEXT);
    expect(contrastRatio(dark.color.border.strong, dark.color.bg.surface)).toBeCloseTo(2.86, 2);
  });

  it('text.disabled is exempt from AA but still documented at 3.06:1 (light, on surface)', () => {
    expect(contrastRatio(light.color.text.disabled, light.color.bg.surface)).toBeGreaterThanOrEqual(3.06 - 0.005);
  });

  it('money colours meet body-text contrast on canvas and surface in both modes', () => {
    for (const [, theme] of modes) {
      for (const bg of [theme.color.bg.canvas, theme.color.bg.surface]) {
        expect(contrastRatio(theme.color.money.in, bg)).toBeGreaterThanOrEqual(WCAG_AA_TEXT);
        expect(contrastRatio(theme.color.money.out, bg)).toBeGreaterThanOrEqual(WCAG_AA_TEXT);
      }
    }
  });
});
