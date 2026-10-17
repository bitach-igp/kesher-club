// Inline banner: subtle fill, 4 px start bar in the status colour, optional action.
import { StyleSheet, View } from 'react-native';
import { useTheme } from '../theme.ts';
import { Txt } from './Txt.tsx';
import { Button } from './Button.tsx';

export type BannerTone = 'warning' | 'danger' | 'success' | 'info';

export interface BannerProps {
  tone: BannerTone;
  title?: string;
  body: string;
  action?: { label: string; onPress: () => void };
  testID?: string;
}

export function Banner({ tone, title, body, action, testID }: BannerProps) {
  const th = useTheme();
  const bar = tone === 'info' ? th.color.action.primary : th.color.status[tone];
  const fill = tone === 'info' ? th.color.action.primarySubtle : th.color.status[`${tone}Subtle`];
  return (
    <View
      accessibilityRole={tone === 'danger' ? 'alert' : 'summary'}
      accessibilityLiveRegion="polite"
      testID={testID}
      style={[styles.wrap, { backgroundColor: fill, borderRadius: th.radius.md, borderStartWidth: 4, borderStartColor: bar, padding: th.space[4], gap: th.space[2] }]}
    >
      {title ? <Txt variant="headline">{title}</Txt> : null}
      <Txt variant="callout">{body}</Txt>
      {action ? <Button variant="tertiary" label={action.label} onPress={action.onPress} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({ wrap: { alignSelf: 'stretch' } });
