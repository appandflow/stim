import { matchingDeviceFrame } from './device-frame';
import type { DeviceFrameArtwork } from '@/protocol/types';

const artwork: DeviceFrameArtwork = {
  width: 120,
  height: 240,
  aperture: { x: 10, y: 20, width: 100, height: 200 },
  cornerRadius: 12,
  quarterTurns: 0,
  background: 'png',
  foreground: 'png',
};

it('falls back until artwork belongs to the current capture, including same-size half turns', () => {
  const source = { width: 400, height: 800, artworkTurns: 0 };
  expect(matchingDeviceFrame(artwork, source)).toBe(artwork);
  expect(matchingDeviceFrame(artwork, { ...source, artworkTurns: 2 })).toBeNull();
  expect(matchingDeviceFrame({ ...artwork, quarterTurns: 2 }, source)).toBeNull();
  expect(matchingDeviceFrame({ ...artwork, quarterTurns: 2 }, { ...source, artworkTurns: 2 })).not.toBeNull();
  expect(matchingDeviceFrame(artwork, { ...source, height: 400 })).toBeNull();
  expect(matchingDeviceFrame(artwork, { ...source, artworkTurns: undefined })).toBeNull();
  expect(matchingDeviceFrame(artwork, { ...source, posture: 'folded' })).toBeNull();
});
