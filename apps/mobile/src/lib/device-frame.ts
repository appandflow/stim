import type { DeviceFrameArtwork } from '@/protocol/types';

/** Matches installed housing to the guest capture, including rotations that keep its width and height. */
export function matchingDeviceFrame(
  artwork: DeviceFrameArtwork | null,
  source: { width: number; height: number; artworkTurns?: number; posture?: string } | null,
): DeviceFrameArtwork | null {
  if (!artwork || !source || source.posture || source.artworkTurns !== artwork.quarterTurns) return null;
  const { aperture } = artwork;
  const aspect = aperture.width / aperture.height;
  return Math.abs(source.width / source.height - aspect) / aspect < 0.01 ? artwork : null;
}
