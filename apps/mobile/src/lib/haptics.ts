import * as Haptics from 'expo-haptics';
import { Platform } from 'react-native';

export function hapticFeedback(kind: 'menu' | 'selection' | 'success'): void {
  if (Platform.OS === 'android') {
    const api = Number(Platform.Version);
    const type = {
      menu: api >= 30 ? Haptics.AndroidHaptics.Gesture_Start : Haptics.AndroidHaptics.Context_Click,
      selection: api >= 34 ? Haptics.AndroidHaptics.Segment_Tick : Haptics.AndroidHaptics.Keyboard_Tap,
      success: api >= 30 ? Haptics.AndroidHaptics.Confirm : Haptics.AndroidHaptics.Virtual_Key,
    }[kind];
    void Haptics.performAndroidHapticsAsync(type).catch(() => {});
  } else if (Platform.OS === 'ios') {
    const feedback =
      kind === 'menu'
        ? Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
        : kind === 'selection'
          ? Haptics.selectionAsync()
          : Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    void feedback.catch(() => {});
  }
}
