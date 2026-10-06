import { deviceUnavailable } from './device-unavailable';
import type { DeviceRef } from './workspaces';

const stopped: DeviceRef = {
  platform: 'ios',
  slot: 'default',
  id: 'sim',
  name: 'iPhone',
  model: 'iPhone',
  state: 'Shutdown',
  running: false,
  owned: true,
  physical: false,
};
const unavailable = {
  hasStatus: true,
  workspaceListed: true,
  hasArchive: false,
  recordingDisabled: false,
  hasFootage: false,
  range: null,
  device: stopped,
};
const empty = { enabled: true, recording: false, spans: [], markers: [] };

test('names a removed workspace before recording state once status confirms it is gone', () => {
  expect(
    deviceUnavailable({
      ...unavailable,
      workspaceListed: false,
      recordingDisabled: true,
      range: empty,
      device: undefined,
    }),
  ).toBe('This workspace is no longer on this Mac.');
  for (const overrides of [{ hasStatus: false }, { hasArchive: true }]) {
    expect(deviceUnavailable({ ...unavailable, workspaceListed: false, device: undefined, ...overrides })).toBe(
      'This device is not running.',
    );
  }
});

test('explains recording was off before reporting an empty range', () => {
  expect(deviceUnavailable({ ...unavailable, recordingDisabled: true, range: empty })).toBe(
    'Recording was off for this workspace.',
  );
});

test('explains an empty recording only after the range loads', () => {
  expect(deviceUnavailable({ ...unavailable, range: empty })).toBe('No recording for this device.');
  expect(deviceUnavailable(unavailable)).toBe('Shutdown');
});

test('preserves device state and unserved reasons, and the fallback before status or range arrives', () => {
  expect(deviceUnavailable({ ...unavailable, device: undefined })).toBe('This device is not running.');
  expect(deviceUnavailable({ ...unavailable, hasFootage: true, range: empty })).toBe('Shutdown');
  expect(
    deviceUnavailable({
      ...unavailable,
      recordingDisabled: true,
      range: empty,
      device: { ...stopped, running: true, owned: false },
    }),
  ).toBe('Frames are only served for devices Stim owns.');
});
