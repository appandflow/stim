import { requireNativeModule, requireNativeView } from 'expo';
import type { ComponentType } from 'react';
import type { NativeSyntheticEvent, StyleProp, ViewStyle } from 'react-native';

export interface StimVideoViewProps {
  /** Routes {@link pushAccessUnit} calls with the same id to this view. */
  streamId: string;
  style?: StyleProp<ViewStyle>;
  /** The decoder lost its state, as after the app was in the background, and waits for a keyframe. */
  onKeyframeNeeded?: (event: NativeSyntheticEvent<Record<string, never>>) => void;
  /** Old pixels have been cleared for this orientation generation; newly decoded pixels belong to it. */
  onOrientationCleared?: (event: NativeSyntheticEvent<{ generation: number }>) => void;
}

const StimVideo = requireNativeModule<{
  push: (streamId: string, accessUnit: Uint8Array, width: number, height: number) => void;
  pushWithOrientation?: (
    streamId: string,
    accessUnit: Uint8Array,
    width: number,
    height: number,
    generation: number,
  ) => void;
}>('StimVideo');

export const supportsFrameOrientation = typeof StimVideo.pushWithOrientation === 'function';

export const StimVideoView: ComponentType<StimVideoViewProps> = requireNativeView('StimVideo');

/**
 * Decodes one Annex-B H.264 access unit in the mounted view with `streamId`. `width` and `height` are the
 * coded size the frame header carries. The view stays black until a keyframe carrying its SPS and PPS arrives,
 * and fills its bounds, so the caller sizes it to the video's aspect ratio. The bytes are copied before this
 * returns.
 */
export function pushAccessUnit(
  streamId: string,
  accessUnit: Uint8Array,
  width: number,
  height: number,
  generation?: number,
): void {
  if (generation !== undefined && StimVideo.pushWithOrientation) {
    StimVideo.pushWithOrientation(streamId, accessUnit, width, height, generation);
  } else {
    StimVideo.push(streamId, accessUnit, width, height);
  }
}
