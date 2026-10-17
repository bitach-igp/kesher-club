// List row: 64 min height (72 with a subtitle), trailing text or chevron, inset divider.
import { Pressable, StyleSheet, View } from 'react-native';
import { useTheme } from '../theme.ts';
import { Txt } from './Txt.tsx';

export interface ListRowProps {
  title: string;
  subtitle?: string;
  trailing?: string;
  onPress?: () => void;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  testID?: string;
  last?: boolean;
}

export function ListRow({ title, subtitle, trailing, onPress, accessibilityLabel, accessibilityHint, testID, last = false }: ListRowProps) {
  const th = useTheme();
  const body = (
    <View style={[styles.row, { minHeight: subtitle ? 72 : 64, paddingHorizontal: th.space[4], gap: th.space[3] }]}>
      <View style={styles.text}>
        <Txt variant="body" style={{ fontWeight: '500' }}>
          {title}
        </Txt>
        {subtitle ? (
          <Txt variant="caption" tone="secondary">
            {subtitle}
          </Txt>
        ) : null}
      </View>
      {trailing !== undefined ? (
        <Txt variant="body" tabular>
          {trailing}
        </Txt>
      ) : onPress ? (
        <Txt variant="body" tone="secondary" accessibilityElementsHidden importantForAccessibility="no">
          ›
        </Txt>
      ) : null}
    </View>
  );
  const divider = last ? null : <View style={{ height: th.borderWidth.default, backgroundColor: th.color.border.default, marginStart: th.space[4] }} />;
  if (!onPress)
    return (
      <View testID={testID}>
        {body}
        {divider}
      </View>
    );
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? (subtitle ? `${title}. ${subtitle}` : title)}
        {...(accessibilityHint !== undefined ? { accessibilityHint } : {})}
        onPress={onPress}
        testID={testID}
        style={({ pressed }) => (pressed ? { backgroundColor: th.color.bg.sunken } : null)}
      >
        {body}
      </Pressable>
      {divider}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 12 },
  text: { flex: 1, gap: 2 },
});
