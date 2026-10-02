import * as Haptics from 'expo-haptics';
import { Platform } from 'react-native';

import { hapticFeedback } from './haptics';

jest.mock('expo-haptics', () => ({
  AndroidHaptics: {
    Gesture_Start: 'gesture-start',
    Segment_Tick: 'segment-tick',
    Confirm: 'confirm',
    Context_Click: 'context-click',
    Keyboard_Tap: 'keyboard-tap',
    Virtual_Key: 'virtual-key',
  },
  ImpactFeedbackStyle: { Light: 'light' },
  NotificationFeedbackType: { Success: 'success' },
  performAndroidHapticsAsync: jest.fn().mockResolvedValue(undefined),
  impactAsync: jest.fn().mockResolvedValue(undefined),
  selectionAsync: jest.fn().mockResolvedValue(undefined),
  notificationAsync: jest.fn().mockResolvedValue(undefined),
}));

beforeEach(() => jest.clearAllMocks());
afterEach(() => jest.restoreAllMocks());

it('uses Android native interaction feedback rather than vibrator effects', () => {
  jest.replaceProperty(Platform, 'OS', 'android');
  jest.spyOn(Platform, 'Version', 'get').mockReturnValue(34);
  hapticFeedback('menu');
  hapticFeedback('selection');
  hapticFeedback('success');
  expect(Haptics.performAndroidHapticsAsync).toHaveBeenNthCalledWith(1, Haptics.AndroidHaptics.Gesture_Start);
  expect(Haptics.performAndroidHapticsAsync).toHaveBeenNthCalledWith(2, Haptics.AndroidHaptics.Segment_Tick);
  expect(Haptics.performAndroidHapticsAsync).toHaveBeenNthCalledWith(3, Haptics.AndroidHaptics.Confirm);
  expect(Haptics.impactAsync).not.toHaveBeenCalled();
  expect(Haptics.selectionAsync).not.toHaveBeenCalled();
  expect(Haptics.notificationAsync).not.toHaveBeenCalled();
});

it.each([24, 33])('does not request nonexistent native constants on Android API %i', (api) => {
  jest.replaceProperty(Platform, 'OS', 'android');
  jest.spyOn(Platform, 'Version', 'get').mockReturnValue(api);
  hapticFeedback('menu');
  hapticFeedback('selection');
  hapticFeedback('success');
  expect(Haptics.performAndroidHapticsAsync).toHaveBeenNthCalledWith(
    1,
    api >= 30 ? Haptics.AndroidHaptics.Gesture_Start : Haptics.AndroidHaptics.Context_Click,
  );
  expect(Haptics.performAndroidHapticsAsync).toHaveBeenNthCalledWith(2, Haptics.AndroidHaptics.Keyboard_Tap);
  expect(Haptics.performAndroidHapticsAsync).toHaveBeenNthCalledWith(
    3,
    api >= 30 ? Haptics.AndroidHaptics.Confirm : Haptics.AndroidHaptics.Virtual_Key,
  );
});

it('uses light opening, selection and result feedback on iOS', () => {
  jest.replaceProperty(Platform, 'OS', 'ios');
  hapticFeedback('menu');
  hapticFeedback('selection');
  hapticFeedback('success');
  expect(Haptics.impactAsync).toHaveBeenCalledWith(Haptics.ImpactFeedbackStyle.Light);
  expect(Haptics.selectionAsync).toHaveBeenCalledTimes(1);
  expect(Haptics.notificationAsync).toHaveBeenCalledWith(Haptics.NotificationFeedbackType.Success);
  expect(Haptics.performAndroidHapticsAsync).not.toHaveBeenCalled();
});

it.each(['ios', 'android'] as const)('does not surface an unavailable %s haptic as an action failure', async (os) => {
  jest.replaceProperty(Platform, 'OS', os);
  jest.mocked(Haptics.selectionAsync).mockRejectedValueOnce(new Error('unavailable'));
  jest.mocked(Haptics.performAndroidHapticsAsync).mockRejectedValueOnce(new Error('unavailable'));
  expect(() => hapticFeedback('selection')).not.toThrow();
  await Promise.resolve();
});

it('does not request feedback on web', () => {
  jest.replaceProperty(Platform, 'OS', 'web');
  hapticFeedback('menu');
  expect(Haptics.impactAsync).not.toHaveBeenCalled();
  expect(Haptics.performAndroidHapticsAsync).not.toHaveBeenCalled();
});
