import { parseHostedMacosDevice } from '../state/hosted-macos.ts';

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
