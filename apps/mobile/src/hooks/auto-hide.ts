import { useCallback, useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

const HIDE_AFTER_MS = 4000;

/**
 * Controls that hide `HIDE_AFTER_MS` after the last `reveal`, and never while `pinned` or, unless `screenReaderHolds`
 * is false, while a screen reader runs. `toggle` hides them at once when they show and are not held; `hide` hides
 * them unless pinned.
 */
export function useAutoHide(pinned: boolean, screenReaderHolds = true) {
  const [shown, setShown] = useState(true);
  const [revealed, setRevealed] = useState(0);
  const [screenReader, setScreenReader] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void AccessibilityInfo.isScreenReaderEnabled().then((on) => {
      if (!cancelled) setScreenReader(on);
    });
    const subscription = AccessibilityInfo.addEventListener('screenReaderChanged', setScreenReader);
    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, []);
  const held = pinned || (screenReaderHolds && screenReader);
  useEffect(() => {
    if (held || !shown) return;
    const timer = setTimeout(() => setShown(false), HIDE_AFTER_MS);
    return () => clearTimeout(timer);
  }, [held, shown, revealed]);
  const reveal = useCallback(() => {
    setShown(true);
    setRevealed((count) => count + 1);
  }, []);
  const toggle = useCallback(() => {
    setShown((now) => held || !now);
    setRevealed((count) => count + 1);
  }, [held]);
  const hide = useCallback(() => setShown(false), []);
  return { shown: shown || held, reveal, toggle, hide };
}
