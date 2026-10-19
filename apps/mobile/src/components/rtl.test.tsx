// @vitest-environment jsdom
// T-0013 (CLUB-37): Hebrew right to left and Dynamic Type at 200%. Native mirroring under
// I18nManager.isRTL only works when every edge is start/end, so the source of every component and
// screen is held to that; text keeps font scaling on, nothing fixed-height holds a label, and the token
// line height grows with the font. The Hebrew render checks what react-native-web can show in jsdom.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { applyLayoutDirection, LocaleProvider, onward, type LayoutDirection, type Locale } from '../i18n.ts';
import { ListRow } from './ListRow.tsx';
import { OtpInput } from './OtpInput.tsx';
import { TextField } from './TextField.tsx';
import { MAX_FONT_SCALE, scaledLineHeight, Txt } from './Txt.tsx';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.tsx') && !e.name.includes('.test.') ? [path.join(dir, e.name)] : []));
const SOURCES = [...walk(path.join(ROOT, 'src/components')), ...walk(path.join(ROOT, 'app'))].map((file) => ({ file: path.relative(ROOT, file), text: fs.readFileSync(file, 'utf8') }));

/** Physical edges that do not mirror under RTL. */
const PHYSICAL = /\b(margin|padding|border)(Left|Right)\w*\b|[{,\s](left|right)\s*:|['"](left|right)['"]|border(Top|Bottom)(Left|Right)Radius|row-reverse/;
/** Fixed sizes on purely decorative shapes that never hold text, each with its reason. */
const DECORATIVE_FIXED = new Map<string, string>([
  ['src/components/Screen.tsx', 'the 120 × 120 empty-state illustration placeholder'],
  ['src/components/QrCode.tsx', 'the 160 × 160 QR placeholder'],
  ['app/club/esim/usage.tsx', 'the 12-point usage meter bar'],
]);

const wrap = (locale: Locale, node: React.ReactNode) => render(<LocaleProvider value={locale}>{node}</LocaleProvider>);

describe('every component and screen mirrors and scales (T-0013)', () => {
  it('uses start and end edges, never left or right', () => {
    expect(SOURCES.length).toBeGreaterThan(30);
    const offenders = SOURCES.flatMap(({ file, text }) => text.split('\n').flatMap((line, i) => (PHYSICAL.test(line) ? [`${file}:${i + 1}: ${line.trim()}`] : [])));
    expect(offenders).toEqual([]);
  });

  it('keeps font scaling on for every Text and TextInput', () => {
    const tags = SOURCES.flatMap(({ file, text }) => [...text.matchAll(/<(Text|TextInput)\b/g)].map((m) => ({ file, tag: text.slice(m.index, text.indexOf('/>', m.index) + 2) })));
    expect(tags.length).toBeGreaterThan(0);
    for (const { file, tag } of tags) {
      expect(tag, file).toMatch(/\ballowFontScaling\b/);
      expect(tag, file).not.toMatch(/allowFontScaling=\{false\}/);
    }
    expect(SOURCES.filter(({ text }) => /numberOfLines|adjustsFontSizeToFit/.test(text)).map((s) => s.file)).toEqual([]);
  });

  it('puts no fixed height or width on anything that holds a label; only listed decorative shapes have one', () => {
    const fixed = SOURCES.filter(({ text }) => /(?<![A-Za-z])(height|width):\s*\d/.test(text)).map((s) => s.file);
    expect(fixed.sort()).toEqual([...DECORATIVE_FIXED.keys()].sort());
  });

  it('grows the token line height with the font, up to 200%', () => {
    expect(scaledLineHeight(24, 1)).toBe(24);
    expect(scaledLineHeight(24, 1.35)).toBe(33);
    expect(scaledLineHeight(24, 2)).toBe(48);
    expect(scaledLineHeight(24, 3.1)).toBe(24 * MAX_FONT_SCALE);
    expect(scaledLineHeight(24, 0.8)).toBe(24);
  });
});

describe('Hebrew', () => {
  it('turns native RTL on for Hebrew and off for English, and says when a restart applies it', () => {
    const manager = (isRTL: boolean) => {
      const calls: string[] = [];
      const m: LayoutDirection = { isRTL, allowRTL: (b) => void calls.push(`allow:${b}`), forceRTL: (b) => void calls.push(`force:${b}`) };
      return { m, calls };
    };
    const he = manager(false);
    expect(applyLayoutDirection('he', he.m)).toBe(true);
    expect(he.calls).toEqual(['allow:true', 'force:true']);
    expect(applyLayoutDirection('he', manager(true).m)).toBe(false);
    const en = manager(true);
    expect(applyLayoutDirection('en', en.m)).toBe(true);
    expect(en.calls).toEqual(['allow:false', 'force:false']);
  });

  it('text runs right to left with natural alignment; the entry follows; a code stays left to right', () => {
    wrap(
      'he',
      <>
        <Txt testID="he-text">שלום</Txt>
        <TextField label="סכום" value="" testID="he-field" />
        <OtpInput label="קוד" value="12" onChange={() => undefined} testID="he-otp" />
      </>,
    );
    const text = screen.getByTestId('he-text');
    expect(getComputedStyle(text).direction).toBe('rtl');
    expect(getComputedStyle(text).textAlign).not.toMatch(/left|right/);
    expect(getComputedStyle(screen.getByTestId('he-field')).direction).toBe('rtl');
    const boxes = screen.getByTestId('he-otp').previousElementSibling as HTMLElement;
    expect(getComputedStyle(boxes).direction).toBe('ltr');
  });

  it('chevrons and arrows point onward in reading order', () => {
    expect(onward('en')).toEqual({ arrow: '→', chevron: '›' });
    expect(onward('he')).toEqual({ arrow: '←', chevron: '‹' });
    const { unmount } = wrap('he', <ListRow title="הגדרות" onPress={() => undefined} testID="he-row" />);
    expect(screen.getByTestId('he-row').textContent).toContain('‹');
    unmount();
    wrap('en', <ListRow title="Settings" onPress={() => undefined} testID="en-row" />);
    expect(screen.getByTestId('en-row').textContent).toContain('›');
  });

  // The banner's bar uses borderStartWidth; react-native-web resolves start to a physical edge in jsdom,
  // so its mirroring is held by the source scan above rather than by a render here.
});
