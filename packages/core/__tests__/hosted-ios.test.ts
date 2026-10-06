import {
  hostedIosPlacements,
  hostedIosStatus,
  parseHostedIosPlacement,
  hostedIosRecords,
  unreadableHostedIos,
} from '../state/hosted-ios.ts';

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
