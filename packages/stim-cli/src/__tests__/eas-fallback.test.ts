import { checkEasFallback, parseSimulatorAvailability } from '../engine/eas-fallback.ts';

const NAG = [
  `${String.fromCodePoint(0x2605)} eas-cli@24.12.0 is now available.`,
  'To upgrade, run:',
  'npm install -g eas-cli',
  'Proceeding with outdated version.',
  '',
].join('\n');

test('availability output from eas-cli 24.8 decides whether EAS Simulator can be used', () => {
  expect(parseSimulatorAvailability({ stdout: '{\n  "available": true,\n  "accountName": "app_and_flow"\n}' })).toEqual(
    {
      usable: true,
    },
  );
  expect(parseSimulatorAvailability({ stdout: '{"available": false, "accountName": "someone"}' })).toMatchObject({
    usable: false,
    code: 'eas-not-enabled',
  });
  expect(
    parseSimulatorAvailability({
      failure: `${NAG}(node:65425) [DEP0040] DeprecationWarning: The \`punycode\` module is deprecated.\n(Use \`node --trace-deprecation ...\` to show where the warning was created)\nRun this command inside a project directory.\n    Error: simulator:availability command failed.\n`,
    }),
  ).toEqual({
    usable: false,
    code: 'eas-unavailable',
    reason: 'eas simulator:availability failed: Run this command inside a project directory.',
  });
  expect(parseSimulatorAvailability({ failure: `${NAG}Not logged in\n` })).toMatchObject({ code: 'eas-logged-out' });
  expect(parseSimulatorAvailability({ failure: '', timedOut: true })).toMatchObject({ code: 'eas-unavailable' });
  expect(parseSimulatorAvailability({ stdout: 'oops' })).toMatchObject({ code: 'eas-unavailable' });
});

const session = {
  platform: 'ios' as const,
  sessionId: 'drs_1',
  startedAt: null,
  webPreviewUrl: null,
  deviceType: 'iPhone 17',
};

const usable = {
  root: '/project',
  platform: 'ios' as const,
  slot: 'default',
  release: false,
  isExpo: false,
  tunnelMode: null,
  publicUrl: null,
  localOnlyFlags: [],
  env: {},
  resolveBin: () => ({ file: '/bin/eas', source: 'path' as const }),
  readVersion: () => 'eas-cli/24.8.0 darwin-arm64 node-v22.22.2',
  onPath: (bin: string) => bin === 'agent-device' || bin === 'ngrok',
  readTunnel: () => null,
  readSession: () => null,
  metroPort: () => 8081,
};

test('a run that --remote eas would refuse falls through before asking EAS', async () => {
  const availability = vi.fn<(bin: string) => Promise<{ stdout: string }>>(async () => ({
    stdout: '{"available": true}',
  }));
  const check = (overrides: Partial<Parameters<typeof checkEasFallback>[0]>) =>
    checkEasFallback({ ...usable, availability, ...overrides });
  const cases: [Partial<Parameters<typeof checkEasFallback>[0]>, string][] = [
    [{ slot: 'tablet' }, 'eas-named-slot'],
    [{ localOnlyFlags: ['--runtime'] }, 'eas-local-flags'],
    [{ onPath: () => false }, 'eas-no-agent-device'],
    [{ resolveBin: () => null }, 'eas-no-cli'],
    [{ readVersion: () => 'eas-cli/21.5.0 darwin-arm64' }, 'eas-cli-too-old'],
    [{ readVersion: () => 'eas-cli/22.1.0 darwin-arm64', deviceTypeFlag: 'iPhone 17' }, 'eas-cli-too-old'],
    [{ onPath: (bin) => bin === 'agent-device' }, 'eas-metro-unreachable'],
    [{ tunnelMode: 'tailscale', onPath: () => true }, 'eas-metro-unreachable'],
    [{ tunnelMode: 'expo', isExpo: true }, 'eas-metro-unreachable'],
    [{ tunnelMode: 'off' }, 'eas-metro-unreachable'],
    [{ platform: 'android', readSession: () => session }, 'eas-session-busy'],
    [{ deviceTypeFlag: 'iPad Pro', readSession: () => session }, 'eas-session-busy'],
    [{ deviceTypeFlag: 'iPad Pro', readSession: () => ({ ...session, deviceType: null }) }, 'eas-session-busy'],
  ];
  for (const [overrides, code] of cases) expect(await check(overrides)).toMatchObject({ usable: false, code });
  expect(availability).not.toHaveBeenCalled();

  expect(await check({})).toEqual({ usable: true });
  expect(await check({ readSession: () => session, deviceTypeFlag: 'iPhone 17' })).toEqual({ usable: true });
  expect(await check({ release: true, onPath: (bin) => bin === 'agent-device' })).toEqual({ usable: true });
  expect(
    await check({
      tunnelMode: 'expo',
      isExpo: true,
      readTunnel: () => ({ kind: 'expo', url: 'https://x.exp.direct' }),
    }),
  ).toEqual({ usable: true });
  expect(await check({ onPath: (bin) => bin === 'agent-device', publicUrl: 'https://metro.example' })).toEqual({
    usable: true,
  });
  expect(availability).toHaveBeenCalledWith('/bin/eas');
});
