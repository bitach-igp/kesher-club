// expo-router group layout for the auth stack: no header, canvas background. The real app's root
// layout provides Api/Session/Router/Authenticator contexts (see README.md).
import type { ReactNode } from 'react';
import { View } from 'react-native';
import { useTheme } from '../../src/theme.ts';

export default function AuthLayout({ children }: { children?: ReactNode }) {
  const th = useTheme();
  return <View style={{ flex: 1, backgroundColor: th.color.bg.canvas }}>{children}</View>;
}
