// Text with the type scale from the tokens. Font scaling is always on (Dynamic Type up to 200%);
// no fixed heights anywhere so text reflows.
import { Text, type TextProps, type TextStyle } from 'react-native';
import { useTheme } from '../theme.ts';
import { useLocale } from '../i18n.ts';

type Variant = 'display' | 'title1' | 'title2' | 'headline' | 'body' | 'callout' | 'caption' | 'micro';
type Tone = 'primary' | 'secondary' | 'disabled' | 'action' | 'danger' | 'success' | 'warning' | 'onAction';

export interface TxtProps extends TextProps {
  variant?: Variant;
  tone?: Tone;
  tabular?: boolean;
}

export function Txt({ variant = 'body', tone = 'primary', tabular = false, style, ...rest }: TxtProps) {
  const th = useTheme();
  const locale = useLocale();
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
    lineHeight: type.lineHeight,
    fontWeight: type.fontWeight as TextStyle['fontWeight'],
    color,
    writingDirection: locale === 'he' ? 'rtl' : 'ltr',
    textAlign: 'left',
    ...(variant === 'micro' ? { letterSpacing: th.typography.micro.letterSpacing, textTransform: 'uppercase' } : {}),
    ...(tabular ? { fontVariant: ['tabular-nums'] } : {}),
  };
  return <Text allowFontScaling maxFontSizeMultiplier={2} style={[base, style]} {...rest} />;
}
