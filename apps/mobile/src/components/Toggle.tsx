// Toggle (51 × 31 track, action.primary when on) with label and hint on the start side.
import { Pressable, StyleSheet, Switch, View } from 'react-native';
import { useTheme } from '../theme.ts';
import { Txt } from './Txt.tsx';

export interface ToggleProps {
  label: string;
  hint?: string;
  value: boolean;
  onChange(next: boolean): void;
  testID?: string;
}

export function Toggle({ label, hint, value, onChange, testID }: ToggleProps) {
  const th = useTheme();
  return (
    <Pressable accessibilityRole="switch" accessibilityLabel={label} {...(hint !== undefined ? { accessibilityHint: hint } : {})} accessibilityState={{ checked: value }} onPress={() => onChange(!value)} testID={testID} style={[styles.row, { gap: th.space[3], minHeight: 44 }]}>
      <View style={styles.text}>
        <Txt variant="body">{label}</Txt>
        {hint ? (
          <Txt variant="caption" tone="secondary">
            {hint}
          </Txt>
        ) : null}
      </View>
      <Switch value={value} onValueChange={onChange} trackColor={{ true: th.color.action.primary, false: th.color.border.strong }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" />
    </Pressable>
  );
}

const styles = StyleSheet.create({ row: { flexDirection: 'row', alignItems: 'center' }, text: { flex: 1, gap: 2 } });
