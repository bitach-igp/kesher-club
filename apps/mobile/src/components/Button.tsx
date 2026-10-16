// Buttons from the component library: primary / secondary / tertiary / destructive. 52 high on
// mobile (44 for tertiary) as a minimum, never a fixed height, so a scaled label still fits.
import { ActivityIndicator, Pressable, StyleSheet, View, type ViewStyle } from 'react-native';
import { useTheme } from '../theme.ts';
import { Txt } from './Txt.tsx';

export type ButtonVariant = 'primary' | 'secondary' | 'tertiary' | 'destructive';

export interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  loading?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  testID?: string;
}

export function Button({ label, onPress, variant = 'primary', disabled = false, loading = false, accessibilityLabel, accessibilityHint, testID }: ButtonProps) {
  const th = useTheme();
  const fill: ViewStyle =
    variant === 'primary' ? { backgroundColor: th.color.action.primary }
    : variant === 'destructive' ? { backgroundColor: th.color.status.danger }
    : variant === 'secondary' ? { backgroundColor: th.color.bg.surface, borderWidth: th.borderWidth.default, borderColor: th.color.border.strong }
    : { backgroundColor: 'transparent' };
  const tone = variant === 'primary' || variant === 'destructive' ? 'onAction' : 'action';
  const inactive = disabled || loading;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      {...(accessibilityHint !== undefined ? { accessibilityHint } : {})}
      accessibilityState={{ disabled: inactive, busy: loading }}
      disabled={inactive}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [
        styles.base,
        { minHeight: variant === 'tertiary' ? 44 : 52, paddingHorizontal: th.space[5], borderRadius: th.radius.md, opacity: disabled ? 0.4 : 1 },
        fill,
        pressed && variant === 'primary' ? { backgroundColor: th.color.action.primaryHover, transform: [{ scale: 0.98 }] } : null,
        pressed && variant === 'secondary' ? { backgroundColor: th.color.action.primarySubtle } : null,
      ]}
    >
      <View style={styles.content}>
        {loading ? <ActivityIndicator accessibilityLabel={label} color={tone === 'onAction' ? th.color.text.onAction : th.color.action.primary} /> : null}
        <Txt variant="headline" tone={tone} style={[styles.label, loading ? styles.hidden : null]}>
          {label}
        </Txt>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: { alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center' },
  content: { alignItems: 'center', justifyContent: 'center' },
  label: { textAlign: 'center', paddingVertical: 12 },
  hidden: { position: 'absolute', opacity: 0 },
});
