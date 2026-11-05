import { t } from '@lingui/core/macro';
import * as Clipboard from 'expo-clipboard';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, View } from 'react-native';
import Animated, { FadeIn, FadeOut, useReducedMotion, ZoomIn, ZoomOut } from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/icon';
import { Text } from '@/components/text';
import { Touch } from '@/components/touch';
import { withAlpha } from '@/design/color';
import { createCopyFeedback } from '@/lib/copy-feedback';
import { hapticFeedback } from '@/lib/haptics';

/** Copies text, then reports `copied` for two seconds with a light haptic and a screen reader announcement. */
export function useCopy() {
  const [copied, setCopied] = useState(false);
  const [feedback] = useState(() => createCopyFeedback(setCopied));
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      feedback.cancel();
    };
  }, [feedback]);
  const copy = useCallback(
    async (text: string) => {
      await Clipboard.setStringAsync(text);
      if (!mounted.current) return;
      hapticFeedback('menu');
      AccessibilityInfo.announceForAccessibility(t`Copied`);
      feedback.start();
    },
    [feedback],
  );
  return { copied, copy };
}

/**
 * The look of a copy button: the symbol and label swap as `copied` changes, the pill takes the success tint and keeps
 * the width of its widest label. With Reduce Motion it swaps at once. Press handling belongs to the parent.
 */
export function CopyPill({
  copied,
  title,
  copiedTitle,
  filled = true,
  showsIcon = true,
}: {
  copied: boolean;
  title?: string;
  copiedTitle?: string;
  filled?: boolean;
  showsIcon?: boolean;
}) {
  const { theme } = useUnistyles();
  const reduceMotion = useReducedMotion();
  const tint = copied ? theme.colors.success : theme.colors.primary;
  const idleLabel = title ?? t`Copy`;
  const copiedLabel = copiedTitle ?? t`Copied`;
  const label = copied ? copiedLabel : idleLabel;
  return (
    <View style={[styles.pill, filled && { backgroundColor: withAlpha(tint, 0.12) }]}>
      {showsIcon ? (
        <Animated.View
          key={copied ? 'copied' : 'copy'}
          entering={reduceMotion ? undefined : ZoomIn.duration(180)}
          exiting={reduceMotion ? undefined : ZoomOut.duration(120)}
        >
          <Icon name={copied ? 'checkmark' : 'doc.on.doc'} size={13} color={tint} />
        </Animated.View>
      ) : null}
      <View>
        <View style={styles.sizer} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <Text variant="footnote" weight="semibold">
            {idleLabel}
          </Text>
          <View style={styles.sizerRest}>
            <Text variant="footnote" weight="semibold">
              {copiedLabel}
            </Text>
          </View>
        </View>
        <Animated.View
          key={label}
          style={styles.label}
          entering={reduceMotion ? undefined : FadeIn.duration(180)}
          exiting={reduceMotion ? undefined : FadeOut.duration(120)}
        >
          <Text variant="footnote" weight="semibold" style={{ color: tint }}>
            {label}
          </Text>
        </Animated.View>
      </View>
    </View>
  );
}

/** A pill button that copies `text` and morphs to "Copied" for two seconds. */
export function CopyButton({
  text,
  title,
  copiedTitle,
  accessibilityLabel,
  filled,
  showsIcon,
}: {
  text: string | (() => string);
  title?: string;
  copiedTitle?: string;
  accessibilityLabel?: string;
  filled?: boolean;
  showsIcon?: boolean;
}) {
  const { copied, copy } = useCopy();
  const { theme } = useUnistyles();
  const label = accessibilityLabel ?? title ?? t`Copy`;
  return (
    <Touch
      feedback="opacity"
      onPress={() => void copy(typeof text === 'function' ? text() : text)}
      accessibilityLabel={copied ? `${copiedTitle ?? t`Copied`}, ${label}` : label}
      hitSlop={{ top: 8, bottom: 8, left: theme.space.md, right: theme.space.md }}
      style={{ minHeight: 44, justifyContent: 'center' }}
    >
      <CopyPill copied={copied} title={title} copiedTitle={copiedTitle} filled={filled} showsIcon={showsIcon} />
    </Touch>
  );
}

const styles = StyleSheet.create((theme) => ({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.space.xs,
    borderRadius: theme.radius.round,
    paddingVertical: theme.space.xs,
    paddingHorizontal: theme.space.md,
    overflow: 'hidden',
  },
  sizer: { opacity: 0 },
  sizerRest: { height: 0, overflow: 'hidden' },
  label: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
}));
