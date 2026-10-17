// Theme access for screens: light/dark from @kesher/tokens, following the system unless Settings
// overrides it (Tab 2, "Dark mode follows the system setting, with a manual override").
import { createContext, useContext } from 'react';
import { useColorScheme } from 'react-native';
import { theme as tokens, type Theme, type ThemeMode } from '@kesher/tokens';

export type { Theme, ThemeMode };

/** `undefined` follows the system. */
export const ThemeOverrideContext = createContext<ThemeMode | undefined>(undefined);
export const ThemeOverrideProvider = ThemeOverrideContext.Provider;

export function useThemeMode(): ThemeMode {
  const override = useContext(ThemeOverrideContext);
  const system = useColorScheme();
  return override ?? (system === 'dark' ? 'dark' : 'light');
}

export function useTheme(): Theme {
  return tokens[useThemeMode()];
}
