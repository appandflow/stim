import { eventEnumCases, replaceReceivedField } from '../../mock-server/receive-fixtures';
import type { FrameEvent } from '@/protocol/types';
import { matchingDeviceFrame, supportsFrame } from './device-frame';
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

test.each(eventEnumCases.filter(([, path]) => ['platform', 'posture', 'mime'].includes(path)))(
  'ignores unsupported captures at %j %s instead of choosing a device path',
  (fixture, path) => {
    expect(supportsFrame(fixture as FrameEvent, 'ios')).toBe(true);
    expect(supportsFrame(replaceReceivedField(fixture, path, 'future-kind') as FrameEvent, 'ios')).toBe(false);
  },
);
