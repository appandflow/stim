import { parseHostedAgentGrant, parseHostedMacosDevice } from '../state/hosted-macos.ts';

test('a hosted macOS identity names exactly the host and one reserved app slot', () => {
  const device = { architecture: 'arm64', macosVersion: '27.0', appSlot: 1 };
  expect(parseHostedMacosDevice(device)).toEqual(device);
  for (const value of [
    { ...device, appSlot: 0 },
    { ...device, appSlot: 65 },
    { ...device, appSlot: 1.5 },
    { ...device, macosVersion: '27.0 beta' },
    { ...device, architecture: 'arm64e' },
    { ...device, udid: '12345678-1234-1234-1234-123456789abc' },
  ])
    expect(parseHostedMacosDevice(value)).toBeNull();
});

test('an agent grant is usable only for a known driver, one session route, and a bounded token', () => {
  const grant = {
    driver: 'agent-device',
    path: '/device-host/agent/12345678-1234-1234-1234-123456789abc/',
    token: 'a'.repeat(43),
    scope: 'lease-1',
  };
  expect(parseHostedAgentGrant(grant)).toEqual(grant);
  expect(parseHostedAgentGrant({ driver: 'none' })).toEqual({ driver: 'none' });
  for (const value of [
    { driver: 'none', token: grant.token },
    { ...grant, driver: 'argent' },
    { ...grant, path: '/device-host/agent/../other/' },
    { ...grant, token: 'short' },
    { ...grant, extra: true },
  ])
    expect(parseHostedAgentGrant(value)).toBeNull();
});
