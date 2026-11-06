// Balance hero (T-0671, purses T-0679): the shekel balance large, the dollar balance beside it when the member holds one. Amounts go
// through `format(Money, locale)`, never a Number, so a bigint stays exact. Without `purses` the hero reads as one line to a screen
// reader. With `purses` (Home) each currency folds into the hero: its available balance, what is on hold when money is reserved, and
// the way into that currency's activity; then the hero is not one accessible node, so those buttons stay reachable.
import { format, type Currency, type Money } from '@kesher/domain';
import { Platform, Pressable, StyleSheet, View } from 'react-native';
import { intlLocale, useLocale } from '../i18n.ts';
import { useTheme } from '../theme.ts';
import { Txt } from './Txt.tsx';

export interface HeroPurse {
  currency: Currency;
  available: Money;
  /** Shown as `holdsText` when money is reserved; the text is built by the caller (it is copy). */
  holds?: Money;
  holdsText?: string;
  availableLabel: string;
  seeAllLabel: string;
  onOpen(): void;
}

export interface BalanceHeroProps {
  label: string;
  ils: Money;
  usd?: Money;
  purses?: readonly HeroPurse[];
  testID?: string;
}

export function BalanceHero({ label, ils, usd, purses, testID }: BalanceHeroProps) {
  const th = useTheme();
  const locale = useLocale();
  const main = format(ils, intlLocale(locale));
  // On native, mirroring follows I18nManager (applied at the restart `applyLayoutDirection` reports); only react-native-web needs the
  // direction set, because there the page has no native layout manager.
  const webDirection = Platform.OS === 'web' ? { direction: locale === 'he' ? ('rtl' as const) : ('ltr' as const) } : null;
  const frame = [styles.hero, { backgroundColor: th.color.action.primary, borderRadius: th.radius.lg, padding: th.space[5], gap: th.space[1] }, webDirection];
  if (purses && purses.length > 0) {
    return (
      <View testID={testID} style={frame}>
        <Txt variant="caption" tone="onAction" accessibilityRole="header">
          {label}
        </Txt>
        {purses.map((p, i) => (
          <View key={p.currency} testID={`home-purse-${p.currency}`} style={{ gap: th.space[1], marginTop: i === 0 ? 0 : th.space[3] }}>
            <Txt variant="caption" tone="onAction">
              {p.availableLabel}
            </Txt>
            <Txt variant={i === 0 ? 'display' : 'title1'} tone="onAction" tabular>
              {format(p.available, intlLocale(locale))}
            </Txt>
            {p.holdsText ? (
              <Txt tone="onAction" testID={`home-holds-${p.currency}`}>
                {p.holdsText}
              </Txt>
            ) : null}
            <Pressable accessibilityRole="button" accessibilityLabel={`${p.seeAllLabel} · ${p.currency}`} onPress={p.onOpen} testID={`home-wallet-${p.currency}`} style={{ minHeight: 44, justifyContent: 'center' }}>
              <Txt variant="callout" tone="onAction">
                {p.seeAllLabel}
              </Txt>
            </Pressable>
          </View>
        ))}
      </View>
    );
  }
  const side = usd ? format(usd, intlLocale(locale)) : undefined;
  return (
    <View testID={testID} accessible accessibilityLabel={side ? `${label}. ${main}. ${side}` : `${label}. ${main}`} style={frame}>
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
