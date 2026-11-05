// Tab bar (T-0671): a row of tabs along the bottom, each at least 44 points tall, the active one marked with `selected` and the
// brand colour. On native the row mirrors with I18nManager (start/end edges only); on react-native-web it sets `direction` from the locale,
// so the first tab sits at the reading start in both.
import { Platform, Pressable, StyleSheet, View } from 'react-native';
import { useLocale } from '../i18n.ts';
import { useTheme } from '../theme.ts';
import { Txt } from './Txt.tsx';

export interface TabItem {
  key: string;
  label: string;
  /** A short glyph shown above the label; decorative, hidden from screen readers. */
  glyph: string;
}

export interface TabBarProps {
  items: readonly TabItem[];
  active: string;
  onSelect(key: string): void;
  testID?: string;
}

export function TabBar({ items, active, onSelect, testID }: TabBarProps) {
  const th = useTheme();
  const locale = useLocale();
  const webDirection = Platform.OS === 'web' ? { direction: locale === 'he' ? ('rtl' as const) : ('ltr' as const) } : null;
  return (
    <View
      testID={testID}
      accessibilityRole="tablist"
      style={[styles.bar, { backgroundColor: th.color.bg.surface, borderTopWidth: th.borderWidth.default, borderTopColor: th.color.border.default, paddingHorizontal: th.space[2] }, webDirection]}
    >
      {items.map((t) => {
        const on = t.key === active;
        return (
          <Pressable key={t.key} accessibilityRole="tab" accessibilityLabel={t.label} accessibilityState={{ selected: on }} aria-selected={on} onPress={() => onSelect(t.key)} style={[styles.tab, { minHeight: 44, paddingVertical: th.space[2] }]}>
            <Txt variant="callout" tone={on ? 'action' : 'secondary'} accessibilityElementsHidden importantForAccessibility="no">
              {t.glyph}
            </Txt>
            <Txt variant="micro" tone={on ? 'action' : 'secondary'}>
              {t.label}
            </Txt>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({ bar: { flexDirection: 'row', alignSelf: 'stretch' }, tab: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 2 } });
