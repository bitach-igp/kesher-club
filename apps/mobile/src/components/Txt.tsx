// Text with the type scale from the tokens. Font scaling is always on (Dynamic Type up to 200%);
// no fixed heights anywhere so text reflows. The token line height is scaled with the font, because
// React Native scales the glyphs but not a fixed lineHeight, and a 200% label would clip. Alignment is
// natural (start), so Hebrew sits on the right under native RTL; never a physical left or right.
import { Text, useWindowDimensions, type TextProps, type TextStyle } from 'react-native';
import { useTheme } from '../theme.ts';
import { useLocale } from '../i18n.ts';

type Variant = 'display' | 'title1' | 'title2' | 'headline' | 'body' | 'callout' | 'caption' | 'micro';
type Tone = 'primary' | 'secondary' | 'disabled' | 'action' | 'danger' | 'success' | 'warning' | 'onAction';

export interface TxtProps extends TextProps {
  variant?: Variant;
  tone?: Tone;
  tabular?: boolean;
}

/** Dynamic Type is honoured up to this multiple. */
export const MAX_FONT_SCALE = 2;

/** The token line height at the device's font scale, capped where the font itself stops growing. */
export function scaledLineHeight(lineHeight: number, fontScale: number): number {
  return Math.ceil(lineHeight * Math.min(Math.max(fontScale, 1), MAX_FONT_SCALE));
}

export function Txt({ variant = 'body', tone = 'primary', tabular = false, style, ...rest }: TxtProps) {
  const th = useTheme();
  const locale = useLocale();
  const { fontScale } = useWindowDimensions();
  const type = th.typography[variant];
  const color =
    tone === 'action' ? th.color.action.primary
    : tone === 'danger' ? th.color.status.danger
    : tone === 'success' ? th.color.status.success
    : tone === 'warning' ? th.color.status.warning
    : th.color.text[tone];
  const base: TextStyle = {
    fontFamily: locale === 'he' ? th.font.family.hebrew : type.fontFamily,
    fontSize: type.fontSize,
    lineHeight: scaledLineHeight(type.lineHeight, fontScale),
    fontWeight: type.fontWeight as TextStyle['fontWeight'],
    color,
    writingDirection: locale === 'he' ? 'rtl' : 'ltr',
    textAlign: 'auto',
    ...(variant === 'micro' ? { letterSpacing: th.typography.micro.letterSpacing, textTransform: 'uppercase' } : {}),
    ...(tabular ? { fontVariant: ['tabular-nums'] } : {}),
  };
  return <Text allowFontScaling maxFontSizeMultiplier={MAX_FONT_SCALE} style={[base, style]} {...rest} />;
}
