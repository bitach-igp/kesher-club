// WCAG 2.1 relative luminance and contrast ratio (https://www.w3.org/TR/WCAG21/#dfn-contrast-ratio).
// Used by the tests to verify every ratio the design spec claims; exported so apps can check
// dynamic colour pairs (e.g. merchant brand colours) against the same function.

const HEX = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i;

/** `#RRGGBB` or `#RRGGBBAA` -> 0..255 channels. The alpha channel is ignored for contrast. */
export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = HEX.exec(hex);
  if (!m) throw new Error(`contrast: expected #RRGGBB[AA], got ${JSON.stringify(hex)}`);
  const n = parseInt(m[1]!, 16);
  return { r: n >> 16, g: (n >> 8) & 255, b: n & 255 };
}

const linearise = (channel: number): number => {
  const s = channel / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

/** Relative luminance (0 = black, 1 = white) of an sRGB hex colour. */
export function relativeLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  return 0.2126 * linearise(r) + 0.7152 * linearise(g) + 0.0722 * linearise(b);
}

/** Contrast ratio between two opaque colours, 1..21, order independent. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [light, dark] = la >= lb ? [la, lb] : [lb, la];
  return (light + 0.05) / (dark + 0.05);
}

export const WCAG_AA_TEXT = 4.5;
export const WCAG_AA_LARGE_TEXT = 3;
export const WCAG_AA_NON_TEXT = 3;

/** True when `foreground` on `background` meets the given AA threshold (body text by default). */
export function meetsContrast(foreground: string, background: string, minimum = WCAG_AA_TEXT): boolean {
  return contrastRatio(foreground, background) >= minimum;
}
