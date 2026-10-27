import assert from 'node:assert';
import {
  parseLocationRequest,
  parseNetworkRequest,
  parsePackagePermissions,
  parsePermissionRequest,
  parsePushRequest,
  runDeviceTool,
  type ToolDeps,
  type ToolFailure,
  type ToolResult,
} from '../commands/device-tools.ts';
import type { ProjectRecord } from '../workspace/config.ts';

const UDID = 'A0E35E7A-7304-4A3D-8F64-D451DE794C8E';
const SERIAL = 'emulator-5554';
const PACKAGE = 'com.example.app';

const project: ProjectRecord = {
  bundleId: 'com.example.ios',
  androidPackage: PACKAGE,
  platforms: {
    ios: { deviceUdid: UDID, deviceName: 'stim-ios', owned: true },
    android: { avdName: 'stim-android', serial: SERIAL, owned: true },
  },
};

function dump(grants: Record<string, boolean>): string {
  return [
    'Packages:',
    '  Package [com.example.app] (abc):',
    '    runtime permissions:',
    ...Object.entries(grants).map(([name, granted]) => `      ${name}: granted=${granted}, flags=[ USER_SET]`),
  ].join('\n');
}

function harness(over: Partial<ToolDeps> = {}, replies: (args: string[]) => string = () => '') {
  const calls: { file: string; args: string[]; input?: string }[] = [];
  const out: string[] = [];
  const note: string[] = [];
  const deps: Partial<ToolDeps> = {
    findProjectRoot: () => '/ws',
    getProject: () => project,
    hostedSlots: () => [],
    readRemotePlatform: () => null,
    readLaunch: () => null,
    resolveIos: async () => ({ name: 'stim-ios', booted: true }),
    resolveAndroid: async () => SERIAL,
    run: async (file, args, options) => {
      calls.push({ file, args, ...(options.input === undefined ? {} : { input: options.input }) });
      return replies(args);
    },
    out: (line) => out.push(line),
    note: (line) => note.push(line),
    ...over,
  };
  return { deps, calls, out, note };
}

const isFailure = (result: object): result is ToolFailure => 'code' in result && 'message' in result;

function failed(result: object): ToolFailure {
  assert(isFailure(result), JSON.stringify(result));
  return result;
}

function succeeded(result: ToolResult | ToolFailure): ToolResult {
  assert(!isFailure(result), JSON.stringify(result));
  return result;
}

describe('argument parsing', () => {
  test('--set takes a negative latitude and refuses out-of-range or malformed coordinates', () => {
    expect(parseLocationRequest('ios', { set: '-33.86,151.21' })).toEqual({
      tool: 'location',
      platform: 'ios',
      latitude: -33.86,
      longitude: 151.21,
    });
    for (const set of ['91,0', '0,181', '45.5', 'north,west', '45.5;-73.6']) {
      expect(failed(parseLocationRequest('ios', { set })).code).toBe('STIM_BAD_ARG');
    }
  });

  test('location needs exactly one of --set and --clear, and Android cannot clear', () => {
    expect(failed(parseLocationRequest('ios', {})).code).toBe('STIM_BAD_ARG');
    expect(failed(parseLocationRequest('ios', { set: '1,2', clear: true })).code).toBe('STIM_BAD_ARG');
    expect(failed(parseLocationRequest('android', { clear: true })).code).toBe('STIM_DEVICE_TOOL_UNSUPPORTED');
    expect(failed(parseLocationRequest('web', { clear: true })).code).toBe('STIM_BAD_ARG');
  });

  test('permission services are per platform: iOS has no camera, Android has no all', () => {
    expect(parsePermissionRequest('ios', 'grant', 'photos')).toMatchObject({ tool: 'permission', service: 'photos' });
    expect(failed(parsePermissionRequest('ios', 'grant', 'camera')).code).toBe('STIM_BAD_ARG');
    expect(failed(parsePermissionRequest('android', 'grant', 'all')).code).toBe('STIM_BAD_ARG');
    expect(failed(parsePermissionRequest('android', 'allow', 'camera')).code).toBe('STIM_BAD_ARG');
  });

  test('push takes an APNs object on iOS only, and network is Android only', () => {
    expect(failed(parsePushRequest('ios', { payload: '{"alert":"x"}' })).code).toBe('STIM_BAD_ARG');
    expect(failed(parsePushRequest('ios', { payload: 'not json' })).code).toBe('STIM_BAD_ARG');
    expect(failed(parsePushRequest('android', { payload: '{"aps":{}}' })).code).toBe('STIM_DEVICE_TOOL_UNSUPPORTED');
    expect(failed(parseNetworkRequest('ios', 'off')).code).toBe('STIM_DEVICE_TOOL_UNSUPPORTED');
    expect(failed(parseNetworkRequest('android', 'maybe')).code).toBe('STIM_BAD_ARG');
  });
});

describe('target ownership', () => {
  const request = { tool: 'location', platform: 'ios', clear: true } as const;
  const androidRequest = { tool: 'network', platform: 'android', enabled: false } as const;

  const refusals: [string, Partial<ToolDeps>, typeof request | typeof androidRequest][] = [
    ['a hosted slot', { hostedSlots: () => ['default'] }, request],
    ['an EAS session', { readRemotePlatform: () => ({ platform: null, sessionId: 's1' }) }, request],
    [
      'a record that is not owned (a physical device)',
      {
        getProject: () => ({ platforms: { ios: { deviceUdid: UDID } } }),
      },
      request,
    ],
    ['a simulator Stim does not own', { resolveIos: async () => 'notOwned' as const }, request],
    ['a simulator that is not booted', { resolveIos: async () => ({ name: 'stim-ios', booted: false }) }, request],
    ['an emulator that is not running', { resolveAndroid: async () => null }, androidRequest],
    ['a project with no Android record', { getProject: () => ({ platforms: {} }) }, androidRequest],
  ];

  test.each(refusals)('%s refuses with STIM_DEVICE_TOOL_TARGET and runs no tool', async (_name, over, req) => {
    const h = harness(over);
    const result = failed(await runDeviceTool(req, { json: true }, h.deps));
    expect(result.code).toBe('STIM_DEVICE_TOOL_TARGET');
    expect(h.calls).toEqual([]);
    expect(JSON.parse(h.out.join('\n'))).toMatchObject({ code: 'STIM_DEVICE_TOOL_TARGET' });
  });

  test('an EAS session recorded for the other platform does not block this one', async () => {
    const h = harness({ readRemotePlatform: () => ({ platform: 'android', sessionId: 's1' }) });
    expect(succeeded(await runDeviceTool(request, {}, h.deps)).tool).toBe('location');
  });

  test('permission and push refuse when no app is recorded for the device', async () => {
    const h = harness({ getProject: () => ({ platforms: project.platforms }) });
    const req = parsePermissionRequest('ios', 'grant', 'photos');
    assert(!isFailure(req));
    expect(failed(await runDeviceTool(req, {}, h.deps)).code).toBe('STIM_DEVICE_TOOL_TARGET');
    expect(h.calls).toEqual([]);
  });

  test('the slot launch record names the app, ahead of the project record', async () => {
    const h = harness({ readLaunch: () => ({ appId: 'com.example.launched', deviceId: UDID }) });
    const req = parsePermissionRequest('ios', 'grant', 'photos');
    assert(!isFailure(req));
    succeeded(await runDeviceTool(req, {}, h.deps));
    expect(h.calls[0]?.args).toEqual(['simctl', 'privacy', UDID, 'grant', 'photos', 'com.example.launched']);
  });
});

describe('iOS tool calls', () => {
  test('simctl takes the UDID right after the verb, and push reads the payload from stdin', async () => {
    const h = harness();
    succeeded(await runDeviceTool(parseLocationRequest('ios', { set: '45.5,-73.6' }), {}, h.deps));
    succeeded(await runDeviceTool(parseLocationRequest('ios', { clear: true }), {}, h.deps));
    const push = parsePushRequest('ios', { payload: '{"aps":{"alert":"Hi"}}' });
    const result = succeeded(await runDeviceTool(push, { json: true }, h.deps));
    expect(h.calls).toEqual([
      { file: 'xcrun', args: ['simctl', 'location', UDID, 'set', '45.5,-73.6'] },
      { file: 'xcrun', args: ['simctl', 'location', UDID, 'clear'] },
      { file: 'xcrun', args: ['simctl', 'push', UDID, 'com.example.ios', '-'], input: '{"aps":{"alert":"Hi"}}' },
    ]);
    expect(result.readBack).toBeNull();
  });

  test('a push refused because the app has no notification permission says how to get it', async () => {
    const h = harness({
      run: async () => {
        throw Object.assign(new Error('Command failed'), {
          stderr: 'Repository could not save notification. Source is not authorized.',
        });
      },
    });
    const push = parsePushRequest('ios', { payload: '{"aps":{"alert":"Hi"}}' });
    const result = failed(await runDeviceTool(push, {}, h.deps));
    expect(result.code).toBe('STIM_DEVICE_TOOL_FAILED');
    expect(result.remedy).toContain('notification prompt');
  });

  test('a failing simctl call becomes STIM_DEVICE_TOOL_FAILED with the tool output', async () => {
    const h = harness({
      run: async () => {
        throw Object.assign(new Error('Command failed'), { stderr: 'Invalid service name' });
      },
    });
    const req = parsePermissionRequest('ios', 'revoke', 'photos');
    const result = failed(await runDeviceTool(req, {}, h.deps));
    expect(result.code).toBe('STIM_DEVICE_TOOL_FAILED');
    expect(result.message).toContain('Invalid service name');
  });
});

describe('Android read-back', () => {
  const fine = 'android.permission.ACCESS_FINE_LOCATION';
  const coarse = 'android.permission.ACCESS_COARSE_LOCATION';

  test('parsePackagePermissions reads grant state and omits permissions the dump does not list', () => {
    expect(
      parsePackagePermissions(dump({ [fine]: true, [coarse]: false }), [fine, coarse, 'android.permission.CAMERA']),
    ).toEqual([
      { name: fine, granted: true },
      { name: coarse, granted: false },
    ]);
  });

  test('a grant reads each declared permission back; one the app does not declare is skipped, not hidden', async () => {
    let granted = false;
    const h = harness({}, (args) => {
      if (args.includes('grant')) granted = true;
      return dump({ [fine]: granted });
    });
    const req = parsePermissionRequest('android', 'grant', 'location');
    assert(!isFailure(req));
    const result = succeeded(await runDeviceTool(req, { json: true }, h.deps));
    expect(result.readBack).toEqual({ permissions: [{ name: fine, granted: true }] });
    expect(result.skipped).toEqual([coarse]);
    expect(h.out).toHaveLength(1);
  });

  test('an app that declares none of a service refuses; a device that disagrees after the change fails', async () => {
    const req = parsePermissionRequest('android', 'grant', 'camera');
    assert(!isFailure(req));
    const none = harness({}, (args) => (args.includes('dumpsys') ? dump({ [fine]: true }) : ''));
    const refused = failed(await runDeviceTool(req, {}, none.deps));
    expect(refused.code).toBe('STIM_DEVICE_TOOL_FAILED');
    expect(refused.message).toContain('declares none of the camera permissions');

    const stuck = harness({}, (args) => (args.includes('dumpsys') ? dump({ 'android.permission.CAMERA': false }) : ''));
    const result = failed(await runDeviceTool(req, {}, stuck.deps));
    expect(result.code).toBe('STIM_DEVICE_TOOL_FAILED');
    expect(result.message).toContain('did not report camera as granted');
  });

  test('reset revokes and clears the user-set flags so the app asks again', async () => {
    const h = harness({}, (args) => (args.includes('dumpsys') ? dump({ 'android.permission.CAMERA': false }) : ''));
    const req = parsePermissionRequest('android', 'reset', 'camera');
    assert(!isFailure(req));
    succeeded(await runDeviceTool(req, {}, h.deps));
    const camera = 'android.permission.CAMERA';
    expect(h.calls.slice(0, 2).map((call) => call.args.slice(2))).toEqual([
      ['shell', 'pm', 'revoke', PACKAGE, camera],
      ['shell', 'pm', 'clear-permission-flags', PACKAGE, camera, 'user-set', 'user-fixed'],
    ]);
  });

  test('network off reports the Wi-Fi and data settings it read, and fails when either is still on', async () => {
    const settings: Record<string, string> = { wifi_on: '0', mobile_data: '0' };
    const h = harness({}, (args) => settings[args.at(-1) ?? ''] ?? '');
    const off = parseNetworkRequest('android', 'off');
    assert(!isFailure(off));
    expect(succeeded(await runDeviceTool(off, {}, h.deps)).readBack).toEqual({ wifi: false, data: false });
    expect(h.calls.map((call) => call.args.join(' '))).toContain(`-s ${SERIAL} shell svc wifi disable`);

    settings.mobile_data = '1';
    expect(failed(await runDeviceTool(off, {}, h.deps)).code).toBe('STIM_DEVICE_TOOL_FAILED');
  });

  test('the emulator console answers KO with exit status 0, which is still a failure', async () => {
    const h = harness({}, () => 'KO: bad fix\n');
    const result = failed(await runDeviceTool(parseLocationRequest('android', { set: '1,2' }), {}, h.deps));
    expect(result.code).toBe('STIM_DEVICE_TOOL_FAILED');
    expect(result.message).toContain('KO: bad fix');
  });

  test('geo fix takes longitude before latitude', async () => {
    const h = harness();
    const result = succeeded(await runDeviceTool(parseLocationRequest('android', { set: '45.5,-73.6' }), {}, h.deps));
    expect(h.calls[0]?.args).toEqual(['-s', SERIAL, 'emu', 'geo', 'fix', '-73.6', '45.5']);
    expect(result).toMatchObject({ latitude: 45.5, longitude: -73.6, readBack: null });
  });
});
