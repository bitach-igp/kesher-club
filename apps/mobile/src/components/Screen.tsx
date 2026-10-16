// Screen scaffold: canvas background, 16 gutters, scrolls, keyboard-safe, optional pinned footer.
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View, type ViewStyle } from 'react-native';
import type { ReactNode } from 'react';
import { useTheme } from '../theme.ts';
import { Txt } from './Txt.tsx';

export interface ScreenProps {
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
  testID?: string;
}

export function Screen({ title, subtitle, children, footer, testID }: ScreenProps) {
  const th = useTheme();
  const canvas: ViewStyle = { backgroundColor: th.color.bg.canvas };
  return (
    <KeyboardAvoidingView style={[styles.fill, canvas]} behavior={Platform.OS === 'ios' ? 'padding' : undefined} testID={testID}>
      <ScrollView contentContainerStyle={{ padding: th.layout.gutter.mobile, gap: th.layout.sectionGap }} keyboardShouldPersistTaps="handled">
        <View style={{ gap: th.space[2] }}>
          <Txt variant="title1" accessibilityRole="header">
            {title}
          </Txt>
          {subtitle ? (
            <Txt variant="body" tone="secondary">
              {subtitle}
            </Txt>
          ) : null}
        </View>
        {children}
      </ScrollView>
      {footer ? <View style={{ padding: th.layout.gutter.mobile, gap: th.space[3], backgroundColor: th.color.bg.canvas }}>{footer}</View> : null}
    </KeyboardAvoidingView>
  );
}

export function Card({ children, testID }: { children: ReactNode; testID?: string }) {
  const th = useTheme();
  return (
    <View
      testID={testID}
      style={{ backgroundColor: th.color.bg.surface, borderRadius: th.radius.lg, borderWidth: th.borderWidth.default, borderColor: th.color.border.default, padding: th.layout.cardPadding, gap: th.space[3] }}
    >
      {children}
    </View>
  );
}

export function EmptyState({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  const th = useTheme();
  return (
    <View style={{ alignItems: 'center', gap: th.space[3], paddingVertical: th.space[8] }} accessibilityRole="summary">
      <View accessibilityElementsHidden style={{ width: 120, height: 120, borderRadius: th.radius.full, backgroundColor: th.color.bg.stone }} />
      <Txt variant="title2" style={{ textAlign: 'center' }}>
        {title}
      </Txt>
      <Txt variant="body" tone="secondary" style={{ textAlign: 'center' }}>
        {body}
      </Txt>
      {action}
    </View>
  );
}

export function Skeleton({ lines = 3, testID = 'skeleton' }: { lines?: number; testID?: string }) {
  const th = useTheme();
  return (
    <View accessibilityLabel="Loading" accessibilityRole="progressbar" testID={testID} style={{ gap: th.space[3] }}>
      {Array.from({ length: lines }, (_, i) => (
        <View key={i} style={{ minHeight: 16, borderRadius: th.radius.sm, backgroundColor: th.color.bg.sunken, width: i % 2 ? '60%' : '90%' }} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({ fill: { flex: 1 } });
