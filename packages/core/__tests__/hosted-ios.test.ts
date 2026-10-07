import {
  hostedIosPlacements,
  hostedIosStatus,
  parseHostedIosPlacement,
  hostedIosRecords,
  unreadableHostedIos,
} from '../state/hosted-ios.ts';
import { parseHostedNativeOffer } from '../state/device-host.ts';

const placement = {
  machine: 'mini',
  selected: 'mini',
  session: '12345678-1234-1234-1234-123456789abc',
  appAttempt: 'attempt',
  device: {
    udid: 'abcdef12-1234-1234-1234-123456789abc',
    name: 'iPhone 17 Pro',
    runtime: '27.0',
    deviceType: 'iPhone 17 Pro',
    deviceTypeId: 'iphone',
    runtimeId: 'ios27',
    architecture: 'arm64',
  },
  agent: { driver: 'none', setting: 'hosting.agentDriver' },
};

test('a reservation without a device remains discoverable for stop, including a named slot', () => {
  const pending = { ...placement, device: null };
  expect(hostedIosPlacements({ deviceSlots: { tablet: { ios: { host: pending } } } })).toEqual({ tablet: pending });
  expect(parseHostedIosPlacement(placement)).toEqual(placement);
});

test.each([{ machine: '' }, { session: '' }])('unreadable ownership remains discoverable: %j', (changed) => {
  const state = { ios: { host: { ...placement, ...changed } } };
  expect(parseHostedIosPlacement(state.ios.host)).toBeNull();
  expect(hostedIosPlacements(state)).toEqual({});
  expect(hostedIosRecords(state)).toEqual({ default: state.ios.host });
  expect(unreadableHostedIos('default')).toContain('ios.host.session');
});

test('newer selection, agent and app metadata cannot hide a readable owner from cleanup', () => {
  const future = {
    ...placement,
    selected: { kind: 'auto' },
    agent: { driver: 'agent-device' },
    appAttempt: null,
    device: { unknown: true },
  };
  expect(parseHostedIosPlacement(future)).toEqual({ ...placement, appAttempt: '', device: null });
});

test('public host facts exclude the host UDID and private transport fields', () => {
  const parsed = parseHostedIosPlacement({ ...placement, secret: 'private', gatewayPort: 1234 })!;
  expect(hostedIosStatus(parsed)).toEqual({
    machine: 'mini',
    session: placement.session,
    selected: 'mini',
    device: { name: 'iPhone 17 Pro', runtime: '27.0' },
    agent: placement.agent,
  });
});

test('agent access survives placement reads and status without a token or local device target', () => {
  const agent = {
    driver: 'agent-device',
    remoteConfig: '/tmp/remote.json',
    command: 'agent-device <command> --remote-config /tmp/remote.json',
  };
  const parsed = parseHostedIosPlacement({ ...placement, agent })!;
  expect(parsed.agent).toEqual(agent);
  expect(hostedIosStatus(parsed).agent).toEqual(agent);
  expect(JSON.stringify(hostedIosStatus(parsed))).not.toContain(placement.device.udid);
});

test('automatic placement selection and reason survive public status and old records remain readable', () => {
  const automatic = { ...placement, selected: 'auto', reason: 'load 3.1/core here' };
  const parsed = parseHostedIosPlacement(automatic)!;
  expect(parsed).toEqual(automatic);
  expect(hostedIosStatus(parsed)).toMatchObject({ selected: 'auto', reason: automatic.reason });
  const { selected, ...old } = placement;
  expect(parseHostedIosPlacement(old)?.selected).toBe(selected);
});

test.each([undefined, 0, 2, { unknown: 'simulator inventory unavailable' }])(
  'native offer parsing preserves optional local capacity across a JSON round trip: %j',
  (localDevices) => {
    const offer = {
      platform: 'ios',
      choice: null,
      declined: 'SDK unavailable',
      resources: {
        cpus: 4,
        loadPerCore: 0.5,
        memoryFreeBytes: 1000,
        memoryPressure: 'normal',
        workerDiskFreeBytes: null,
        ...(localDevices !== undefined ? { localDevices } : {}),
      },
    };
    const wire = JSON.parse(JSON.stringify(offer));
    expect(parseHostedNativeOffer(wire)).toEqual(offer);
    for (const invalid of [-1, 1.5, null, { unknown: '' }])
      expect(parseHostedNativeOffer({ ...wire, resources: { ...wire.resources, localDevices: invalid } })).toBeNull();
  },
);
