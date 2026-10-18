// OTP input: 6 boxes drawn over a single input so SMS autofill (oneTimeCode / sms-otp) and
// paste-to-fill work. Boxes are at least 48 wide and 56 high, and grow with Dynamic Type. A code is
// read left to right in every language, so the row of boxes never mirrors under RTL.
import { StyleSheet, TextInput, View } from 'react-native';
import { useTheme } from '../theme.ts';
import { Txt } from './Txt.tsx';

export interface OtpInputProps {
  value: string;
  onChange(code: string): void;
  label: string;
  error?: string;
  disabled?: boolean;
  testID?: string;
}

export const OTP_LENGTH = 6;

export function OtpInput({ value, onChange, label, error, disabled = false, testID = 'otp' }: OtpInputProps) {
  const th = useTheme();
  const digits = Array.from({ length: OTP_LENGTH }, (_, i) => value[i] ?? '');
  return (
    <View style={{ gap: th.space[2] }}>
      <Txt variant="caption" tone="secondary">
        {label}
      </Txt>
      <View style={[styles.boxes, { gap: th.space[2] }]} accessible={false} importantForAccessibility="no-hide-descendants">
        {digits.map((d, i) => (
          <View
            key={i}
            style={{
              minWidth: 48,
              minHeight: 56,
              borderRadius: th.radius.md,
              backgroundColor: th.color.bg.sunken,
              borderWidth: error ? th.borderWidth.error : i === value.length ? th.borderWidth.focus : th.borderWidth.input,
              borderColor: error ? th.color.status.danger : i === value.length ? th.color.border.focus : th.color.border.strong,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Txt variant="title2" tabular>
              {d}
            </Txt>
          </View>
        ))}
      </View>
      <TextInput
        accessibilityLabel={label}
        testID={testID}
        value={value}
        editable={!disabled}
        onChangeText={(text) => onChange(text.replace(/\D/g, '').slice(0, OTP_LENGTH))}
        keyboardType="number-pad"
        inputMode="numeric"
        textContentType="oneTimeCode"
        autoComplete="sms-otp"
        maxLength={OTP_LENGTH}
        allowFontScaling
        style={styles.hiddenInput}
      />
      {error ? (
        <Txt variant="caption" tone="danger" accessibilityRole="alert" accessibilityLiveRegion="polite">
          {error}
        </Txt>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  boxes: { flexDirection: 'row', direction: 'ltr' },
  // Kept on-screen (not display:none) so autofill and the keyboard still target it.
  hiddenInput: { opacity: 0.01, minHeight: 1 },
});
