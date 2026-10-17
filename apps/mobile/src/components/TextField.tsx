// Text field from the component library: label above, 52 min height, error below (announced).
import { StyleSheet, TextInput, View, type TextInputProps } from 'react-native';
import { useTheme } from '../theme.ts';
import { useLocale } from '../i18n.ts';
import { Txt } from './Txt.tsx';

export interface TextFieldProps extends Omit<TextInputProps, 'style'> {
  label: string;
  helper?: string;
  error?: string;
  testID?: string;
}

export function TextField({ label, helper, error, testID, ...input }: TextFieldProps) {
  const th = useTheme();
  const locale = useLocale();
  const borderColor = error ? th.color.status.danger : th.color.border.strong;
  const borderWidth = error ? th.borderWidth.error : th.borderWidth.input;
  return (
    <View style={{ gap: th.space[1] }}>
      <Txt variant="caption" tone="secondary" nativeID={`${testID ?? label}-label`}>
        {label}
      </Txt>
      <TextInput
        accessibilityLabel={label}
        accessibilityLabelledBy={`${testID ?? label}-label`}
        allowFontScaling
        placeholderTextColor={th.color.text.disabled}
        testID={testID}
        style={[
          styles.input,
          {
            minHeight: 52,
            borderRadius: th.radius.md,
            backgroundColor: th.color.bg.sunken,
            borderColor,
            borderWidth,
            padding: th.space[4],
            color: th.color.text.primary,
            fontSize: th.typography.body.fontSize,
            fontFamily: locale === 'he' ? th.font.family.hebrew : th.typography.body.fontFamily,
            textAlign: locale === 'he' ? 'right' : 'left',
          },
        ]}
        {...input}
      />
      {error ? (
        <Txt variant="caption" tone="danger" accessibilityRole="alert" accessibilityLiveRegion="polite">
          {error}
        </Txt>
      ) : helper ? (
        <Txt variant="caption" tone="secondary">
          {helper}
        </Txt>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({ input: {} });
