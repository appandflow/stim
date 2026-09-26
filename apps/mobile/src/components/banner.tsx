import { View } from 'react-native';
import Animated, { FadeInUp, FadeOutUp } from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Button } from '@/components/button';
import { Text } from '@/components/text';
import { withAlpha } from '@/design/color';
import type { Theme } from '@/design/theme';

export type BannerTone = 'neutral' | 'warning' | 'error';

function toneColor(theme: Theme, tone: BannerTone): string {
  return tone === 'neutral' ? theme.colors.secondary : theme.colors[tone];
}

/**
 * A status message. `attached` spans the width under a header, filled in the tone's color; `inline` sits in the
 * content as a tinted card with an optional action.
 */
export function Banner({
  message,
  tone = 'neutral',
  variant = 'inline',
  action,
  style,
}: {
  message: string;
  tone?: BannerTone;
  variant?: 'inline' | 'attached';
  action?: { label: string; onPress: () => void };
  style?: { marginHorizontal: number };
}) {
  const { theme } = useUnistyles();
  if (variant === 'attached') {
    return (
      <Animated.View
        entering={FadeInUp.duration(200)}
        exiting={FadeOutUp.duration(200)}
        style={[
          styles.attached,
          { backgroundColor: tone === 'neutral' ? theme.colors.raised : toneColor(theme, tone) },
          style,
        ]}
      >
        <Text
          variant="footnote"
          weight="semibold"
          tone={tone === 'neutral' ? 'secondary' : undefined}
          style={[styles.attachedText, tone === 'neutral' ? null : { color: theme.colors.background }]}
        >
          {message}
        </Text>
      </Animated.View>
    );
  }
  return (
    <View style={[styles.inline(tone), style]}>
      <Text variant="footnote" tone="secondary" style={styles.inlineText}>
        {message}
      </Text>
      {action ? <Button variant="plain" size="small" title={action.label} onPress={action.onPress} /> : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  attached: { paddingHorizontal: theme.space.xl, paddingVertical: theme.space.sm },
  attachedText: { textAlign: 'center' },
  inline: (tone: BannerTone) => ({
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.lg,
    padding: theme.space.lg,
    borderRadius: theme.radius.card,
    borderCurve: 'continuous',
    backgroundColor: tone === 'neutral' ? theme.colors.raised : withAlpha(toneColor(theme, tone), theme.opacity.subtle),
  }),
  inlineText: { flex: 1 },
}));
