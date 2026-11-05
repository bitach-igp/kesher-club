// Status badge: 20 min height, radius sm, 11/600 on a subtle fill.
import { View } from 'react-native';
import { useTheme } from '../theme.ts';
import { Txt } from './Txt.tsx';

export type BadgeTone = 'success' | 'warning' | 'danger' | 'neutral' | 'brand';

export function Badge({ label, tone = 'neutral', testID }: { label: string; tone?: BadgeTone; testID?: string }) {
  const th = useTheme();
  const fill = tone === 'neutral' ? th.color.bg.sunken : tone === 'brand' ? th.color.action.primarySubtle : th.color.status[`${tone}Subtle`];
  const text = tone === 'neutral' ? 'secondary' : tone === 'brand' ? 'action' : tone;
  return (
    <View testID={testID} style={{ alignSelf: 'flex-start', minHeight: 20, paddingHorizontal: th.space[2], borderRadius: th.radius.sm, backgroundColor: fill, justifyContent: 'center' }}>
      <Txt variant="micro" tone={text}>
        {label}
      </Txt>
    </View>
  );
}
