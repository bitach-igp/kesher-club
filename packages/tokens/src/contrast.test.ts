// T-0006 / T-1019: every colour pair the design spec (Tab 2) lists with a measured contrast ratio must
// meet the ratio it claims, computed with a real WCAG 2.1 relative-luminance function (./contrast.ts).
// The Night Market palette (T-1019) keeps the two ACTION values fixed (navy #293B8F light, cyan #04F7E8
// dark); every other value is a starting value this gate may move: a failing row changes the VALUE in
// tokens.json, never the assertion. The tables below are the claims; the coverage guard at the end makes
// every colour token appear in one of them or in EXEMPT with a reason.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { tint } from '../sd.config.mjs';
import { contrastRatio, meetsContrast, relativeLuminance, WCAG_AA_NON_TEXT, WCAG_AA_TEXT } from './contrast.ts';
import { dark, light, type Theme } from './theme.generated.ts';

const modes: ReadonlyArray<readonly [string, Theme]> = [
  ['light', light],
  ['dark', dark],
];

/** A colour token by dotted path under `color` (`text.primary`); throws on a path that is not a hex colour. */
const at = (t: Theme, path: string): string => {
  const v = path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], t.color);
  if (typeof v !== 'string') throw new Error(`no colour token color.${path}`);
  return v;
};

/** foreground, background, measured ratio the spec claims per mode (light, dark; null = no claim in that mode). */
type Pair = readonly [fg: string, bg: string, claimed: readonly [number | null, number | null]];

/** Text pairs hold 4.5:1 (WCAG AA body text); non-text pairs hold 3:1; each also holds its claimed ratio. */
const textPairs: readonly Pair[] = [
  ['text.primary', 'bg.canvas', [14.66, 17.49]],
  ['text.primary', 'bg.surface', [15.75, 15.57]],
  ['text.primary', 'bg.sunken', [13.62, 18.12]],
  ['text.primary', 'bg.stone', [12.56, 13.09]],
  ['text.primary', 'action.primarySubtle', [13.11, 12.81]],
  ['text.secondary', 'bg.canvas', [5.71, 8.78]],
  ['text.secondary', 'bg.surface', [6.13, 7.82]],
  ['text.onAction', 'action.primary', [9.92, 14.58]],
  ['text.onAction', 'action.primaryHover', [12.41, 16.01]],
  ['action.primary', 'bg.surface', [9.92, 12.98]],
  ['action.primary', 'bg.canvas', [9.23, 14.58]],
  ['action.primary', 'action.primarySubtle', [8.26, 10.68]],
  ['status.success', 'bg.surface', [5.38, 8.54]],
  ['status.warning', 'bg.surface', [5.17, 9.61]],
  ['status.danger', 'bg.surface', [5.52, 7.72]],
  ['status.success', 'bg.canvas', [5.00, 9.59]],
  ['status.warning', 'bg.canvas', [4.81, 10.80]],
  ['status.danger', 'bg.canvas', [5.14, 8.67]],
  ['status.success', 'status.successSubtle', [4.80, 6.49]],
  ['status.warning', 'status.warningSubtle', [4.65, 7.23]],
  ['status.danger', 'status.dangerSubtle', [4.90, 6.07]],
  ['money.in', 'bg.surface', [5.38, 8.54]],
  ['money.in', 'bg.canvas', [5.00, 9.59]],
  ['money.out', 'bg.surface', [15.75, 15.57]],
  ['money.out', 'bg.canvas', [14.66, 17.49]],
  ['facet.blue', 'bg.surface', [5.64, 6.47]],
  ['facet.blue', 'bg.canvas', [5.25, 7.27]],
  ['facet.orange', 'bg.surface', [6.06, 6.77]],
  ['facet.orange', 'bg.canvas', [5.64, 7.61]],
  ['facet.magenta', 'bg.surface', [7.57, 5.98]],
  ['facet.magenta', 'bg.canvas', [7.05, 6.72]],
];


const nonTextPairs: readonly Pair[] = [
  ['border.strong', 'bg.surface', [3.26, 3.10]],
  ['border.strong', 'bg.canvas', [3.03, 3.48]],
  ['border.focus', 'bg.surface', [4.82, 12.98]],
  ['border.focus', 'bg.canvas', [4.48, 14.58]],
  ['accent.blue', 'bg.surface', [4.82, 6.85]],
  ['accent.blue', 'bg.canvas', [4.48, 7.69]],
  ['accent.cyan', 'bg.surface', [9.92, 12.98]],
  ['accent.cyan', 'bg.canvas', [9.23, 14.58]],
  ['facet.yellow', 'bg.surface', [4.92, 11.99]],
  ['facet.yellow', 'bg.canvas', [4.58, 13.46]],
  ['text.disabled', 'bg.surface', [3.06, 3.10]],
  ['accent.sky', 'bg.surface', [null, 3.72]],
  ['accent.sky', 'bg.canvas', [null, 4.18]],
];
/** Hex `#RRGGBBAA` laid over `on`: the colour a scrim leaves over a surface. */
const over = (hex: string, on: string): string => tint(hex.slice(0, 7), on, parseInt(hex.slice(7, 9), 16) / 255);

/** Text laid over the scrim (composited over canvas and surface): onAction on the light scrim, text.primary on the dark one. */
const scrimText = (mode: string): string => (mode === 'light' ? 'text.onAction' : 'text.primary');

/** Literal pins from the spec table (brand values the app copy and the design files quote). */
const literalPins: ReadonlyArray<readonly [string, string, string]> = [
  ['action.primary', 'light', '#293B8F'],
  ['action.primary', 'dark', '#04F7E8'],
  ['accent.blue', 'light', '#1D76BB'],
  ['accent.sky', 'light', '#9ADBF6'],
  ['accent.cyan', 'dark', '#04F7E8'],
  ['facet.yellow', 'dark', '#FAD206'],
];

/** Colour tokens with no contrast claim, each with the reason. Everything else must be in a table above. */
const EXEMPT: Readonly<Record<string, string>> = {
  'border.default': 'decorative card and input hairline; the spec says 3:1 is not required (border.strong carries the 3:1 claim)',
};

const asserted = (): Set<string> => {
  const paths = new Set<string>();
  for (const [fg, bg] of [...textPairs, ...nonTextPairs]) {
    paths.add(fg);
    paths.add(bg);
  }
  paths.add('overlay.scrim');
  for (const [path] of literalPins) paths.add(path);
  return paths;
};

const colourLeaves = (o: unknown, path = ''): string[] =>
  typeof o === 'string' ? [path] : Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => colourLeaves(v, path ? `${path}.${k}` : k));

describe('WCAG helpers', () => {
  it('pins the AA thresholds: 4.5:1 for text and 3:1 for non-text', () => {
    expect(WCAG_AA_TEXT).toBe(4.5);
    expect(WCAG_AA_NON_TEXT).toBe(3);
  });

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

describe('Night Market text contrast (REQ-UX-001, 4.5:1)', () => {
  for (const [fg, bg, claimed] of textPairs) {
    for (const [i, [mode, theme]] of modes.entries()) {
      const claim = claimed[i];
      if (claim === null || claim === undefined) continue;
      it(`${fg} on ${bg} (${mode}) is >= ${WCAG_AA_TEXT}:1 and >= the claimed ${claim}:1`, () => {
        const ratio = contrastRatio(at(theme, fg), at(theme, bg));
        expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_TEXT);
        // The spec rounds to two decimals; allow only that rounding.
        expect(ratio).toBeGreaterThanOrEqual(claim - 0.005);
        expect(meetsContrast(at(theme, fg), at(theme, bg), WCAG_AA_TEXT)).toBe(true);
      });
    }
  }

  it('the facet text claims hold at the stated numbers: blue >= 5.6, orange >= 6.0 on surface, magenta >= 4.5', () => {
    expect(contrastRatio(light.color.facet.blue, light.color.bg.surface)).toBeGreaterThanOrEqual(5.6);
    expect(contrastRatio(light.color.facet.orange, light.color.bg.surface)).toBeGreaterThanOrEqual(6.0);
    expect(contrastRatio(light.color.facet.magenta, light.color.bg.surface)).toBeGreaterThanOrEqual(4.5);
  });

  it('action.primary on white is 9.92:1 (light navy) and on bg.surface is >= 4.5:1 in dark (cyan)', () => {
    expect(contrastRatio(light.color.action.primary, '#FFFFFF')).toBeGreaterThanOrEqual(9.92 - 0.005);
    expect(contrastRatio(dark.color.action.primary, dark.color.bg.surface)).toBeGreaterThanOrEqual(WCAG_AA_TEXT);
  });

  it('light mode: no pair in the text table falls below 4.5:1', () => {
    for (const [fg, bg, claimed] of textPairs) {
      if (claimed[0] !== null) expect(contrastRatio(at(light, fg), at(light, bg)), `${fg} on ${bg}`).toBeGreaterThanOrEqual(WCAG_AA_TEXT);
    }
  });

  it('text laid over the scrim (over canvas and surface) keeps 4.5:1 in both modes', () => {
    for (const [mode, theme] of modes) {
      for (const bg of ['bg.canvas', 'bg.surface']) {
        const under = over(theme.color.overlay.scrim, at(theme, bg));
        expect(contrastRatio(at(theme, scrimText(mode)), under), `${mode} ${scrimText(mode)} over scrim on ${bg}`).toBeGreaterThanOrEqual(WCAG_AA_TEXT);
      }
    }
  });
});

describe('Night Market non-text contrast (3:1)', () => {
  for (const [fg, bg, claimed] of nonTextPairs) {
    for (const [i, [mode, theme]] of modes.entries()) {
      const claim = claimed[i];
      if (claim === null || claim === undefined) continue;
      it(`${fg} on ${bg} (${mode}) is >= ${WCAG_AA_NON_TEXT}:1 and >= the claimed ${claim}:1`, () => {
        const ratio = contrastRatio(at(theme, fg), at(theme, bg));
        expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NON_TEXT);
        expect(ratio).toBeGreaterThanOrEqual(claim - 0.005);
      });
    }
  }

  it('text.disabled is exempt from the AA text rule (disabled labels) but is documented and held to the 3:1 non-text rule, 3.06:1 light on surface', () => {
    expect(contrastRatio(light.color.text.disabled, light.color.bg.surface)).toBeGreaterThanOrEqual(3.06 - 0.005);
  });

  it('border.strong has no discrepancy: plain 3:1 on both surfaces in both modes, no pinned number', () => {
    for (const [, theme] of modes) {
      expect(contrastRatio(theme.color.border.strong, theme.color.bg.surface)).toBeGreaterThanOrEqual(WCAG_AA_NON_TEXT);
      expect(contrastRatio(theme.color.border.strong, theme.color.bg.canvas)).toBeGreaterThanOrEqual(WCAG_AA_NON_TEXT);
    }
  });

  it('the focus ring meets 3:1 on canvas and surface in both modes', () => {
    for (const [, theme] of modes) {
      for (const bg of [theme.color.bg.canvas, theme.color.bg.surface]) {
        expect(contrastRatio(theme.color.border.focus, bg)).toBeGreaterThanOrEqual(WCAG_AA_NON_TEXT);
      }
    }
  });

  it('the literal brand values from the spec table are pinned', () => {
    for (const [path, mode, hex] of literalPins) expect(at(mode === 'light' ? light : dark, path), `${path} (${mode})`).toBe(hex);
  });

  it('accent.cyan and facet.yellow are fills only: no text pair uses them, and their descriptions say so', () => {
    const fillOnly = ['accent.cyan', 'facet.yellow'];
    for (const [fg, bg] of textPairs) {
      expect(fillOnly, `${fg} on ${bg} is a text pair`).not.toContain(fg);
      expect(fillOnly, `${fg} on ${bg} is a text pair`).not.toContain(bg);
    }
    const tokens = JSON.parse(readFileSync(new URL('../tokens.json', import.meta.url), 'utf8')) as {
      color: { accent: { cyan: { $description: string } }; facet: { yellow: { $description: string } } };
    };
    expect(tokens.color.facet.yellow.$description).toMatch(/FILL ONLY/);
    expect(tokens.color.accent.cyan.$description).toMatch(/fills and highlights only/);
    expect(tokens.color.accent.cyan.$description).toMatch(/light value is the navy action/);
  });

  it('accent.gold is removed from the token set', () => {
    expect(colourLeaves(light.color)).not.toContain('accent.gold');
    expect(colourLeaves(dark.color)).not.toContain('accent.gold');
  });
});

describe('money colours', () => {
  it('money.in and money.out meet body-text contrast on canvas and surface in both modes', () => {
    for (const [, theme] of modes) {
      for (const bg of [theme.color.bg.canvas, theme.color.bg.surface]) {
        expect(contrastRatio(theme.color.money.in, bg)).toBeGreaterThanOrEqual(WCAG_AA_TEXT);
        expect(contrastRatio(theme.color.money.out, bg)).toBeGreaterThanOrEqual(WCAG_AA_TEXT);
      }
    }
  });
});

describe('token coverage guard', () => {
  it('every colour token is asserted in a table above or listed in EXEMPT with a reason', () => {
    const covered = asserted();
    const missing = colourLeaves(light.color).filter((p) => !covered.has(p) && !(p in EXEMPT));
    expect(missing, `colour tokens with no contrast assertion and no exemption: ${missing.join(', ')}`).toEqual([]);
  });

  it('EXEMPT lists only real tokens that are not also asserted, each with a reason', () => {
    const covered = asserted();
    const real = new Set(colourLeaves(light.color));
    for (const [path, reason] of Object.entries(EXEMPT)) {
      expect(real.has(path), `${path} is not a token`).toBe(true);
      expect(covered.has(path), `${path} is asserted, drop it from EXEMPT`).toBe(false);
      expect(reason.length, `${path} needs a reason`).toBeGreaterThan(10);
    }
  });

  it('dark and light expose the same colour token paths (parity)', () => {
    expect(colourLeaves(dark.color)).toEqual(colourLeaves(light.color));
  });
});
