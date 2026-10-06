import { hostedIosPlacements, hostedIosStatus, parseHostedIosPlacement } from '../state/hosted-ios.ts';

const placement = {
  machine: 'mini',
  selected: 'mini',
  session: '12345678-1234-1234-1234-123456789abc',
  appAttempt: 'attempt',
  device: {
    udid: 'abcdef12-1234-1234-1234-123456789abc',
    name: 'iPhone 17 Pro',
    runtime: 'iOS 27.0',
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

test.each([
  { device: { ...placement.device, architecture: 'x64' } },
  { session: '' },
  { selected: 'other' },
  { agent: { driver: 'agent-device' } },
])('invalid placement ownership refuses cleanup instead of being discarded: %j', (changed) => {
  expect(parseHostedIosPlacement({ ...placement, ...changed })).toBeNull();
  expect(() => hostedIosPlacements({ ios: { host: { ...placement, ...changed } } })).toThrow('unreadable');
});

test('public host facts exclude the host UDID and private transport fields', () => {
  const parsed = parseHostedIosPlacement({ ...placement, secret: 'private', gatewayPort: 1234 })!;
  expect(hostedIosStatus(parsed)).toEqual({
    machine: 'mini',
    session: placement.session,
    selected: 'mini',
    device: { name: 'iPhone 17 Pro', runtime: 'iOS 27.0' },
    agent: placement.agent,
  });
});
