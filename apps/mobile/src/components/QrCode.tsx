// QR placeholder for the eSIM activation code. The real app renders `payload` with
// react-native-qrcode-svg (needs react-native-svg, a native module). Until then the code is shown
// as text with a copy action, which is the manual-install path on every OS anyway.
import { View } from 'react-native';
import { useTheme } from '../theme.ts';
import { Txt } from './Txt.tsx';

export function QrCode({ payload, label, testID = 'qr' }: { payload: string; label: string; testID?: string }) {
  const th = useTheme();
  return (
    <View accessibilityRole="image" accessibilityLabel={label} testID={testID} style={{ alignSelf: 'center', padding: th.space[4], borderRadius: th.radius.md, backgroundColor: th.color.bg.surface, borderWidth: th.borderWidth.default, borderColor: th.color.border.default, gap: th.space[2] }}>
      <View accessibilityElementsHidden style={{ width: 160, height: 160, backgroundColor: th.color.bg.stone, borderRadius: th.radius.sm }} />
      <Txt variant="caption" tone="secondary" selectable style={{ fontFamily: 'monospace', textAlign: 'center' }}>
        {payload}
      </Txt>
    </View>
  );
}
