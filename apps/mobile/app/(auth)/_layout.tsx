// expo-router group layout for the auth stack: no header, canvas background. The root layout
// (app/_layout.tsx) provides the Api/Session/Router/Authenticator contexts.
import { Slot } from 'expo-router';
import { View } from 'react-native';
import { useTheme } from '../../src/theme.ts';

export default function AuthLayout() {
  const th = useTheme();
  return (
    <View style={{ flex: 1, backgroundColor: th.color.bg.canvas }}>
      <Slot />
    </View>
  );
}
