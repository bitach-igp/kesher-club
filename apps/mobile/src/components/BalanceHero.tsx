// Balance hero (T-0671): the shekel balance large, the dollar balance beside it when the member holds one. Amounts go
// through `format(Money, locale)`, never a Number, so a bigint stays exact. One accessible summary line for a screen reader.
import { format, type Money } from '@kesher/domain';
import { StyleSheet, View } from 'react-native';
import { intlLocale, useLocale } from '../i18n.ts';
import { useTheme } from '../theme.ts';
import { Txt } from './Txt.tsx';

export interface BalanceHeroProps {
  label: string;
  ils: Money;
  usd?: Money;
  testID?: string;
}

export function BalanceHero({ label, ils, usd, testID }: BalanceHeroProps) {
  const th = useTheme();
  const locale = useLocale();
  const main = format(ils, intlLocale(locale));
  const side = usd ? format(usd, intlLocale(locale)) : undefined;
  return (
    <View
      testID={testID}
      accessible
      accessibilityLabel={side ? `${label}. ${main}. ${side}` : `${label}. ${main}`}
      style={[styles.hero, { backgroundColor: th.color.action.primary, borderRadius: th.radius.lg, padding: th.space[5], gap: th.space[1], direction: locale === 'he' ? 'rtl' : 'ltr' }]}
    >
      <Txt variant="caption" tone="onAction">
        {label}
      </Txt>
      <Txt variant="display" tone="onAction" tabular>
        {main}
      </Txt>
      {side ? (
        <Txt variant="callout" tone="onAction" tabular>
          {side}
        </Txt>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({ hero: { alignSelf: 'stretch' } });
