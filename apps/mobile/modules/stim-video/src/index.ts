import { requireNativeModule, requireNativeView } from 'expo';
import type { ComponentType } from 'react';
import type { NativeSyntheticEvent, StyleProp, ViewStyle } from 'react-native';

export interface StimVideoViewProps {
  /** Routes {@link pushAccessUnit} calls with the same id to this view. */
  streamId: string;
  style?: StyleProp<ViewStyle>;
  /** The decoder lost its state, as after the app was in the background, and waits for a keyframe. */
  onKeyframeNeeded?: (event: NativeSyntheticEvent<Record<string, never>>) => void;
}

const StimVideo = requireNativeModule<{
  push: (streamId: string, accessUnit: Uint8Array, width: number, height: number) => void;
}>('StimVideo');

export const StimVideoView: ComponentType<StimVideoViewProps> = requireNativeView('StimVideo');

/**
 * Decodes one Annex-B H.264 access unit in the mounted view with `streamId`. `width` and `height` are the
 * coded size the frame header carries. The view stays black until a keyframe carrying its SPS and PPS arrives,
 * and fills its bounds, so the caller sizes it to the video's aspect ratio. The bytes are copied before this
 * returns.
 */
export function pushAccessUnit(streamId: string, accessUnit: Uint8Array, width: number, height: number): void {
  StimVideo.push(streamId, accessUnit, width, height);
}
