import {
  hostedAndroidPlacements,
  hostedAndroidStatus,
  parseHostedAndroidPlacement,
  hostedAndroidRecords,
  unreadableHostedAndroid,
} from '../state/hosted-android.ts';

const placement = {
  machine: 'mini',
  selected: 'mini',
  session: '12345678-1234-1234-1234-123456789abc',
  appAttempt: 'attempt',
  device: {
    avdName: 'stim-private-host',
    serial: 'emulator-5554',
    consolePort: 5554,
    systemImage: 'system-images;android-30;google_apis;arm64-v8a',
    deviceProfile: 'pixel_7',
    architecture: 'arm64-v8a',
  },
  agent: { driver: 'none', setting: 'hosting.agentDriver' },
};

test('a reservation without a device remains discoverable for stop, including a named slot', () => {
  const pending = { ...placement, device: null };
  expect(hostedAndroidPlacements({ deviceSlots: { tablet: { android: { host: pending } } } })).toEqual({
    tablet: pending,
  });
  expect(parseHostedAndroidPlacement(placement)).toEqual(placement);
});

test.each([{ machine: '' }, { session: '' }])('unreadable ownership remains discoverable: %j', (changed) => {
  const state = { android: { host: { ...placement, ...changed } } };
  expect(parseHostedAndroidPlacement(state.android.host)).toBeNull();
  expect(hostedAndroidPlacements(state)).toEqual({});
  expect(hostedAndroidRecords(state)).toEqual({ default: state.android.host });
  expect(unreadableHostedAndroid('default')).toContain('android.host.session');
});

test('newer selection, agent and app metadata cannot hide a readable owner from cleanup', () => {
  const future = {
    ...placement,
    selected: { kind: 'auto' },
    agent: { driver: 'agent-device' },
    appAttempt: null,
    device: { unknown: true },
  };
  expect(parseHostedAndroidPlacement(future)).toEqual({ ...placement, appAttempt: '', device: null });
});

test('public host facts exclude the host serial and AVD name and private transport fields', () => {
  const parsed = parseHostedAndroidPlacement({ ...placement, secret: 'private', gatewayPort: 1234 })!;
  expect(hostedAndroidStatus(parsed)).toEqual({
    machine: 'mini',
    session: placement.session,
    selected: 'mini',
    device: { name: 'pixel_7 (API 30)', systemImage: placement.device.systemImage, api: 30 },
    agent: placement.agent,
  });
});
