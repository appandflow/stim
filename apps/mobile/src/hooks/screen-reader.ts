import { useEffect, useState } from 'react';
import { AccessibilityInfo, Platform } from 'react-native';

export function useScreenReaderEnabled() {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void AccessibilityInfo.isScreenReaderEnabled().then((on) => {
      if (!cancelled) setEnabled(on);
    });
    const subscription = AccessibilityInfo.addEventListener('screenReaderChanged', setEnabled);
    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, []);
  return enabled;
}

/**
 * Speaks `message` through VoiceOver when it changes. React Native's `accessibilityLiveRegion` is Android only and
 * iOS has no alert trait, so a live-region view is silent on iOS.
 */
export function useAnnounce(message: string | null | undefined) {
  useEffect(() => {
    if (message && Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(message);
  }, [message]);
}
