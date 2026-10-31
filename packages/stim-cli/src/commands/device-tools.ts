import chalk from 'chalk';
import type { Command } from 'commander';
import { hostedNativeRecords } from '@stim-cli/core/state';
import { getExecutor, type ExecOptions } from '../exec.ts';
import { androidToolCwd, androidToolPath, resolveOwnedAvdSerialAsync } from '../devices/android.ts';
import { deviceSlotKey, deviceSlotPlatforms, parseDeviceSlotOption } from '../devices/device-slots.ts';
import { listAllIosSimsAsync, resolveOwnedIosSim } from '../devices/ios.ts';
import { readRemoteSession, readWorkspaceLaunches } from '../supervisor/state.ts';
import { getProject, type ProjectRecord } from '../workspace/config.ts';
import { findProjectRoot, NO_PROJECT_REFUSAL } from '../workspace/project.ts';
import { readWorkspaceState } from '../workspace/workspace-state.ts';

type ToolPlatform = 'ios' | 'android';

export interface ToolOptions {
  slot?: string;
  json?: boolean;
  set?: string;
  clear?: boolean;
  payload?: string;
}

export interface ToolFailure {
  code: string;
  message: string;
  remedy: string | null;
}

type ToolRequest =
  | { tool: 'location'; platform: ToolPlatform; latitude: number; longitude: number }
  | { tool: 'location'; platform: ToolPlatform; clear: true }
  | { tool: 'permission'; platform: ToolPlatform; action: PermissionAction; service: string }
  | { tool: 'push'; platform: 'ios'; payload: string }
  | { tool: 'network'; platform: 'android'; enabled: boolean };

type PermissionAction = 'grant' | 'revoke' | 'reset';

const IOS_SERVICES = [
  'all',
  'calendar',
  'contacts',
  'contacts-limited',
  'location',
  'location-always',
  'media-library',
  'microphone',
  'motion',
  'photos',
  'photos-add',
  'reminders',
  'siri',
] as const;

const ANDROID_SERVICES: Readonly<Record<string, readonly string[]>> = {
  calendar: ['android.permission.READ_CALENDAR', 'android.permission.WRITE_CALENDAR'],
  camera: ['android.permission.CAMERA'],
  contacts: ['android.permission.READ_CONTACTS', 'android.permission.WRITE_CONTACTS'],
  location: ['android.permission.ACCESS_FINE_LOCATION', 'android.permission.ACCESS_COARSE_LOCATION'],
  microphone: ['android.permission.RECORD_AUDIO'],
  motion: ['android.permission.ACTIVITY_RECOGNITION'],
  notifications: ['android.permission.POST_NOTIFICATIONS'],
  photos: ['android.permission.READ_MEDIA_IMAGES', 'android.permission.READ_EXTERNAL_STORAGE'],
};

const SIMCTL_OPTIONS = { timeoutMs: 30_000, killSignal: 'SIGKILL' } as const;
const ADB_OPTIONS = { timeoutMs: 15_000, killSignal: 'SIGKILL' } as const;

const NETWORK_READS = 5;
const NETWORK_READ_INTERVAL_MS = 400;

const TARGET = 'STIM_DEVICE_TOOL_TARGET';
const UNSUPPORTED = 'STIM_DEVICE_TOOL_UNSUPPORTED';
const FAILED = 'STIM_DEVICE_TOOL_FAILED';

interface ToolTarget {
  platform: ToolPlatform;
  slot: string;
  deviceId: string;
  deviceName: string;
  appId: string | null;
}

export interface ToolDeps {
  findProjectRoot: typeof findProjectRoot;
  getProject: (root: string) => ProjectRecord | null;
  hostedSlots: (root: string, platform: ToolPlatform) => string[];
  readRemotePlatform: (root: string) => { platform: ToolPlatform | null; sessionId: string } | null;
  readLaunch: (root: string, platform: ToolPlatform, slot: string) => { appId: string; deviceId: string } | null;
  resolveIos: (udid: string) => Promise<{ name: string; booted: boolean } | 'missing' | 'notOwned'>;
  resolveAndroid: (avdName: string, preferredSerial?: string) => Promise<string | null>;
  run: (file: string, args: string[], options: ExecOptions) => Promise<string>;
  sleep: (ms: number) => Promise<void>;
  out: (line: string) => void;
  note: (line: string) => void;
}

const DEFAULT_DEPS: ToolDeps = {
  findProjectRoot,
  getProject,
  hostedSlots: (root, platform) => Object.keys(hostedNativeRecords(readWorkspaceState(root), platform)),
  readRemotePlatform: (root) => readRemoteSession(root),
  readLaunch: (root, platform, slot) => readWorkspaceLaunches(root)[deviceSlotKey(platform, slot)] ?? null,
  resolveIos: async (udid) => {
    const resolved = resolveOwnedIosSim(udid, await listAllIosSimsAsync({}));
    if (resolved.sim) return { name: resolved.sim.name, booted: resolved.sim.state === 'Booted' };
    return resolved.notOwned === undefined ? 'missing' : 'notOwned';
  },
  resolveAndroid: async (avdName, preferredSerial) =>
    (await resolveOwnedAvdSerialAsync(avdName, { preferredSerial })).serial ?? null,
  run: (file, args, options) => getExecutor().runFileAsync(file, args, options),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  out: (line) => console.log(line),
  note: (line) => console.error(line),
};

function failure(code: string, message: string, remedy: string | null): ToolFailure {
  return { code, message, remedy };
}

function badArg(message: string, remedy: string): ToolFailure {
  return failure('STIM_BAD_ARG', message, remedy);
}

function readPlatform(value: string): ToolPlatform | null {
  return value === 'ios' || value === 'android' ? value : null;
}

const COORDINATE = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/;

function parseCoordinate(value: string): { latitude: number; longitude: number } | null {
  const match = COORDINATE.exec(value);
  if (!match) return null;
  const latitude = Number(match[1]);
  const longitude = Number(match[2]);
  return Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180 ? { latitude, longitude } : null;
}

export function parseLocationRequest(platformArg: string, opts: ToolOptions): ToolRequest | ToolFailure {
  const platform = readPlatform(platformArg);
  if (!platform) {
    return badArg(
      `\`stim device location\` takes ios or android, not ${JSON.stringify(platformArg)}.`,
      'Run `stim device location ios --set 45.5,-73.6` or `stim device location android --set 45.5,-73.6`.',
    );
  }
  if ((opts.set === undefined) === !opts.clear) {
    return badArg(
      'Pass exactly one of --set <lat,lng> or --clear.',
      'Run `stim device location <ios|android> --set 45.5,-73.6`, or `--clear` on iOS.',
    );
  }
  if (opts.clear) {
    return platform === 'android'
      ? failure(
          UNSUPPORTED,
          'The Android emulator has no way to clear a simulated location: `adb emu geo fix` only sets one.',
          'Set another coordinate with `stim device location android --set <lat,lng>`, or restart the emulator with `stim stop` and `stim android`.',
        )
      : { tool: 'location', platform, clear: true };
  }
  const coordinate = parseCoordinate(opts.set ?? '');
  if (!coordinate) {
    return badArg(
      `${JSON.stringify(opts.set)} is not a coordinate.`,
      'Pass latitude and longitude in degrees as one value, such as --set 45.5,-73.6 (latitude within 90, longitude within 180).',
    );
  }
  return { tool: 'location', platform, ...coordinate };
}

export function parsePermissionRequest(
  platformArg: string,
  actionArg: string,
  serviceArg: string,
): ToolRequest | ToolFailure {
  const platform = readPlatform(platformArg);
  if (!platform) {
    return badArg(
      `\`stim device permission\` takes ios or android, not ${JSON.stringify(platformArg)}.`,
      'Run `stim device permission ios grant photos` or `stim device permission android grant camera`.',
    );
  }
  if (actionArg !== 'grant' && actionArg !== 'revoke' && actionArg !== 'reset') {
    return badArg(
      `${JSON.stringify(actionArg)} is not a permission action.`,
      'Use grant, revoke or reset: `stim device permission <ios|android> <grant|revoke|reset> <service>`.',
    );
  }
  const services: readonly string[] = platform === 'ios' ? IOS_SERVICES : Object.keys(ANDROID_SERVICES);
  if (!services.includes(serviceArg)) {
    return badArg(
      `${JSON.stringify(serviceArg)} is not a ${platform} permission service.`,
      `The ${platform} services are ${services.join(', ')}.`,
    );
  }
  return { tool: 'permission', platform, action: actionArg, service: serviceArg };
}

export function parsePushRequest(platformArg: string, opts: ToolOptions): ToolRequest | ToolFailure {
  const platform = readPlatform(platformArg);
  if (!platform) {
    return badArg(
      `\`stim device push\` takes ios, not ${JSON.stringify(platformArg)}.`,
      'Run `stim device push ios --payload \'{"aps":{"alert":"Hello"}}\'`.',
    );
  }
  if (platform === 'android') {
    return failure(
      UNSUPPORTED,
      'Android has no simulated push: the emulator does not deliver notifications from the host.',
      "Send the notification through the app's own push provider, or use `adb shell cmd notification post` for a local one.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(opts.payload ?? '');
  } catch {
    parsed = null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || !('aps' in parsed)) {
    return badArg(
      '--payload must be a JSON object with an "aps" key.',
      'Pass something like --payload \'{"aps":{"alert":{"title":"Hello","body":"World"}}}\'. simctl accepts at most 4096 bytes.',
    );
  }
  return { tool: 'push', platform, payload: JSON.stringify(parsed) };
}

export function parseNetworkRequest(platformArg: string, stateArg: string): ToolRequest | ToolFailure {
  const platform = readPlatform(platformArg);
  if (!platform) {
    return badArg(
      `\`stim device network\` takes android, not ${JSON.stringify(platformArg)}.`,
      'Run `stim device network android off`.',
    );
  }
  if (platform === 'ios') {
    return failure(
      UNSUPPORTED,
      "The iOS simulator shares the Mac's network; `simctl` has no switch to turn it off.",
      'Disconnect the Mac, or use Network Link Conditioner on the Mac.',
    );
  }
  if (stateArg !== 'on' && stateArg !== 'off') {
    return badArg(`${JSON.stringify(stateArg)} is not on or off.`, 'Run `stim device network android on` or `off`.');
  }
  return { tool: 'network', platform, enabled: stateArg === 'on' };
}

function describeError(error: unknown): string {
  const stderr =
    error instanceof Error && 'stderr' in error && typeof error.stderr === 'string' ? error.stderr.trim() : '';
  const message = error instanceof Error ? error.message : String(error);
  return stderr && !message.includes(stderr) ? `${message} ${stderr}` : message;
}

async function resolveToolTarget(
  platform: ToolPlatform,
  slot: string,
  root: string,
  d: ToolDeps,
): Promise<ToolTarget | ToolFailure> {
  const slotText = slot === 'default' ? '' : ` --slot ${slot}`;
  const runCommand = `stim ${platform}${slotText}`;
  const project = d.getProject(root);
  if (!project) {
    return failure('STIM_NO_PROJECT', `No Stim environment is registered for ${root}.`, 'Run `stim start` first.');
  }
  if (d.hostedSlots(root, platform).includes(slot)) {
    return failure(
      TARGET,
      `This workspace's ${platform} device${slotText ? ` in slot ${slot}` : ''} is hosted on another Mac, and device tools act only on the workspace's own local simulator or emulator.`,
      `Run \`${runCommand} --remote local\` to use a local device.`,
    );
  }
  const remote = d.readRemotePlatform(root);
  if (remote && (remote.platform === null || remote.platform === platform)) {
    return failure(
      TARGET,
      `This workspace's remote device is EAS Simulator session ${remote.sessionId}, and device tools act only on the workspace's own local simulator or emulator.`,
      `Run \`${runCommand} --remote local\` to use a local device.`,
    );
  }
  const records = deviceSlotPlatforms(project, slot);
  const launch = d.readLaunch(root, platform, slot);
  if (platform === 'ios') {
    const udid = records?.ios?.owned ? records.ios.deviceUdid : undefined;
    if (!udid) return noOwnedDevice(platform, slot, runCommand);
    const sim = await d.resolveIos(udid);
    if (sim === 'missing' || sim === 'notOwned') {
      return failure(
        TARGET,
        `The recorded iOS simulator ${udid} is ${sim === 'missing' ? 'gone' : 'not owned by this Stim home'}.`,
        `Run \`${runCommand}\` to boot, install and launch this workspace's owned simulator.`,
      );
    }
    if (!sim.booted) {
      return failure(TARGET, `The owned iOS simulator ${sim.name} is not booted.`, `Run \`${runCommand}\` to boot it.`);
    }
    const appId = launch?.deviceId === udid ? launch.appId : (project.bundleId ?? null);
    return { platform, slot, deviceId: udid, deviceName: sim.name, appId };
  }
  const avdName = records?.android?.owned ? records.android.avdName : undefined;
  if (!avdName) return noOwnedDevice(platform, slot, runCommand);
  const serial = await d.resolveAndroid(avdName, launch?.deviceId ?? records?.android?.serial);
  if (!serial) {
    return failure(
      TARGET,
      `The owned Android emulator ${avdName} is not running.`,
      `Run \`${runCommand}\` to boot it.`,
    );
  }
  const appId = launch?.deviceId === serial ? launch.appId : (project.androidPackage ?? null);
  return { platform, slot, deviceId: serial, deviceName: avdName, appId };
}

function noOwnedDevice(platform: ToolPlatform, slot: string, runCommand: string): ToolFailure {
  return failure(
    TARGET,
    `This workspace has no owned ${platform} ${platform === 'ios' ? 'simulator' : 'emulator'}${slot === 'default' ? '' : ` in slot ${slot}`}. Device tools do not act on physical devices or devices Stim does not own.`,
    `Run \`${runCommand}\` to create and boot one.`,
  );
}

interface PermissionReadBack {
  name: string;
  granted: boolean;
}

function parsePackagePermissions(dump: string, names: readonly string[]): (PermissionReadBack & { flags: string[] })[] {
  const states: (PermissionReadBack & { flags: string[] })[] = [];
  for (const name of names) {
    const match = new RegExp(
      `^\\s*${name.replaceAll('.', '\\.')}: granted=(true|false)(?:, flags=\\[([^\\]]*)\\])?`,
      'm',
    ).exec(dump);
    if (match) {
      states.push({
        name,
        granted: match[1] === 'true',
        flags: (match[2] ?? '').split('|').map((flag) => flag.trim()),
      });
    }
  }
  return states;
}

function hasUserFlag(state: { flags: string[] }): boolean {
  return state.flags.some((flag) => /^USER_(SET|FIXED)$/.test(flag));
}

function parseSettingFlag(output: string): boolean | null {
  const value = output.trim();
  return value === '1' ? true : value === '0' ? false : null;
}

export interface ToolResult {
  platform: ToolPlatform;
  slot: string;
  deviceId: string;
  deviceName: string;
  tool: ToolRequest['tool'];
  action?: string;
  latitude?: number;
  longitude?: number;
  service?: string;
  appId?: string | null;
  enabled?: boolean;
  readBack: { permissions: PermissionReadBack[] } | { wifi: boolean; data: boolean } | null;
  skipped?: string[];
}

function noApp(target: ToolTarget): ToolFailure {
  return failure(
    TARGET,
    `No app is recorded for this workspace's ${target.platform} device.`,
    `Run \`stim ${target.platform}${target.slot === 'default' ? '' : ` --slot ${target.slot}`}\` to install and launch the app first.`,
  );
}

async function runIos(request: ToolRequest, target: ToolTarget, d: ToolDeps): Promise<ToolResult | ToolFailure> {
  const simctl = (verb: string, args: string[], input?: string) =>
    d.run('xcrun', ['simctl', verb, target.deviceId, ...args], {
      ...SIMCTL_OPTIONS,
      ...(input === undefined ? {} : { input }),
    });
  const base = {
    platform: target.platform,
    slot: target.slot,
    deviceId: target.deviceId,
    deviceName: target.deviceName,
  };
  if (request.tool === 'location') {
    await simctl('location', 'clear' in request ? ['clear'] : ['set', `${request.latitude},${request.longitude}`]);
    return {
      ...base,
      tool: 'location',
      ...('clear' in request
        ? { action: 'clear' }
        : { action: 'set', latitude: request.latitude, longitude: request.longitude }),
      readBack: null,
    };
  }
  if (request.tool === 'permission') {
    if (!target.appId) return noApp(target);
    await simctl('privacy', [request.action, request.service, target.appId]);
    return {
      ...base,
      tool: 'permission',
      action: request.action,
      service: request.service,
      appId: target.appId,
      readBack: null,
    };
  }
  if (request.tool === 'push') {
    if (!target.appId) return noApp(target);
    await simctl('push', [target.appId, '-'], request.payload);
    return { ...base, tool: 'push', appId: target.appId, readBack: null };
  }
  return failure(UNSUPPORTED, `iOS has no ${request.tool} tool.`, null);
}

async function runAndroid(request: ToolRequest, target: ToolTarget, d: ToolDeps): Promise<ToolResult | ToolFailure> {
  const adb = (args: string[]) =>
    d.run(androidToolPath('adb'), ['-s', target.deviceId, ...args], { ...ADB_OPTIONS, cwd: androidToolCwd() });
  const base = {
    platform: target.platform,
    slot: target.slot,
    deviceId: target.deviceId,
    deviceName: target.deviceName,
  };
  if (request.tool === 'location' && !('clear' in request)) {
    const reply = await adb(['emu', 'geo', 'fix', String(request.longitude), String(request.latitude)]);
    if (/^KO\b/m.test(reply)) {
      return failure(FAILED, `The emulator console refused the location: ${reply.trim()}`, null);
    }
    return {
      ...base,
      tool: 'location',
      action: 'set',
      latitude: request.latitude,
      longitude: request.longitude,
      readBack: null,
    };
  }
  if (request.tool === 'permission') {
    const appId = target.appId;
    if (!appId) return noApp(target);
    const requested = ANDROID_SERVICES[request.service] ?? [];
    // pm exits 0 for a permission the app does not declare on some API levels and fails on others, so the dump decides.
    const pm = (args: string[]) => adb(['shell', 'pm', ...args]).catch(() => '');
    for (const name of requested) {
      if (request.action === 'grant') await pm(['grant', appId, name]);
      else {
        await pm(['revoke', appId, name]);
        if (request.action === 'reset') await pm(['clear-permission-flags', appId, name, 'user-set', 'user-fixed']);
      }
    }
    const states = parsePackagePermissions(await adb(['shell', 'dumpsys', 'package', appId]), requested);
    const permissions = states.map(({ name, granted }) => ({ name, granted }));
    if (permissions.length === 0) {
      return failure(
        FAILED,
        `${appId} declares none of the ${request.service} permissions (${requested.join(', ')}).`,
        `Add one to the app's manifest and rebuild with \`stim android\`; Stim cannot ${request.action} a permission the app does not declare.`,
      );
    }
    const wanted = request.action === 'grant';
    const done = wanted
      ? states.some((state) => state.granted)
      : states.every((state) => !state.granted && (request.action !== 'reset' || !hasUserFlag(state)));
    if (!done) {
      return failure(
        FAILED,
        `${target.deviceName} did not report ${request.service} as ${wanted ? 'granted' : request.action === 'reset' ? 'reset' : 'revoked'} for ${appId} after the change: ${JSON.stringify(states)}`,
        `Run \`adb shell dumpsys package ${appId}\` to read the device state.`,
      );
    }
    const skipped = requested.filter((name) => !permissions.some((permission) => permission.name === name));
    return {
      ...base,
      tool: 'permission',
      action: request.action,
      service: request.service,
      appId,
      readBack: { permissions },
      ...(skipped.length > 0 ? { skipped } : {}),
    };
  }
  if (request.tool === 'network') {
    const verb = request.enabled ? 'enable' : 'disable';
    await adb(['shell', 'svc', 'wifi', verb]);
    await adb(['shell', 'svc', 'data', verb]);
    let wifi: boolean | null = null;
    let data: boolean | null = null;
    for (let attempt = 0; attempt < NETWORK_READS; attempt++) {
      if (attempt > 0) await d.sleep(NETWORK_READ_INTERVAL_MS);
      wifi = parseSettingFlag(await adb(['shell', 'settings', 'get', 'global', 'wifi_on']));
      data = parseSettingFlag(await adb(['shell', 'settings', 'get', 'global', 'mobile_data']));
      if (wifi === request.enabled && data === request.enabled) break;
    }
    if (wifi !== request.enabled || data !== request.enabled) {
      return failure(
        FAILED,
        `${target.deviceName} reports Wi-Fi ${wifi === null ? 'unknown' : wifi ? 'on' : 'off'} and mobile data ${data === null ? 'unknown' : data ? 'on' : 'off'} after asking for ${request.enabled ? 'on' : 'off'}.`,
        'Run `adb shell settings get global wifi_on` and `mobile_data` to read the device state.',
      );
    }
    return { ...base, tool: 'network', enabled: request.enabled, readBack: { wifi, data } };
  }
  return failure(UNSUPPORTED, `Android has no ${request.tool} tool.`, null);
}

function summary(result: ToolResult): string {
  const device = `${result.deviceName} (${result.deviceId})`;
  switch (result.tool) {
    case 'location':
      return result.action === 'clear'
        ? `cleared the simulated location on ${device}.`
        : `set the simulated location on ${device} to ${result.latitude},${result.longitude}.`;
    case 'permission':
      return `${result.action} ${result.service} for ${result.appId} on ${device}.`;
    case 'push':
      return `sent a push to ${result.appId} on ${device}.`;
    case 'network':
      return `turned the network ${result.enabled ? 'on' : 'off'} on ${device}.`;
  }
}

export async function runDeviceTool(
  request: ToolRequest | ToolFailure,
  opts: ToolOptions = {},
  overrides: Partial<ToolDeps> = {},
): Promise<ToolResult | ToolFailure> {
  const d: ToolDeps = { ...DEFAULT_DEPS, ...overrides };
  const report = (problem: ToolFailure): ToolFailure => {
    d.note(chalk.red(`${problem.code}: ${problem.message}`));
    if (problem.remedy) d.note(chalk.dim(problem.remedy));
    if (opts.json) d.out(JSON.stringify(problem));
    return problem;
  };
  if ('code' in request) return report(request);
  const root = d.findProjectRoot(process.cwd());
  if (!root) return report(NO_PROJECT_REFUSAL);
  let target: Awaited<ReturnType<typeof resolveToolTarget>>;
  try {
    target = await resolveToolTarget(request.platform, opts.slot ?? 'default', root, d);
  } catch (error) {
    return report(
      failure(
        FAILED,
        `Stim could not inspect this workspace's ${request.platform} device: ${describeError(error)}`,
        'Run `stim status` and retry when simctl or adb responds.',
      ),
    );
  }
  if ('code' in target) return report(target);
  let result: ToolResult | ToolFailure;
  try {
    result = request.platform === 'ios' ? await runIos(request, target, d) : await runAndroid(request, target, d);
  } catch (error) {
    const reason = describeError(error);
    result = failure(
      FAILED,
      `${request.platform === 'ios' ? 'simctl' : 'adb'} did not complete the ${request.tool} change on ${target.deviceName}: ${reason}`,
      request.tool === 'push' && /not authorized/i.test(reason)
        ? 'The app has no notification permission on this simulator, and `simctl privacy` cannot grant it. Open the app, accept its notification prompt, and send the push again.'
        : `Check that ${target.deviceName} is responsive with \`stim status\`, then retry.`,
    );
  }
  if ('code' in result) return report(result);
  d.out(opts.json ? JSON.stringify(result) : chalk.green(summary(result)));
  return result;
}

const finish = (result: ToolResult | ToolFailure): void => {
  if ('code' in result) process.exit(1);
};

export function registerDeviceTools(device: Command, deps: Partial<ToolDeps> = {}): void {
  device
    .command('location')
    .argument('<platform>', 'ios or android')
    .description(
      "Set or clear the simulated location of this workspace's own simulator or emulator. Android cannot clear one.",
    )
    .option('--set <lat,lng>', 'latitude and longitude in degrees, as one value such as 45.5,-73.6')
    .option('--clear', 'stop simulating a location (iOS only)')
    .option('--slot <name>', 'Use this workspace device slot', parseDeviceSlotOption)
    .option('--json', 'print the result as JSON on stdout')
    .action(async (platform: string, opts: ToolOptions) =>
      finish(await runDeviceTool(parseLocationRequest(platform, opts), opts, deps)),
    );

  device
    .command('permission')
    .argument('<platform>', 'ios or android')
    .argument('<action>', 'grant, revoke or reset')
    .argument('<service>', 'the permission service, such as camera, photos or location')
    .description(
      "Grant, revoke or reset one privacy permission for the app on this workspace's own simulator or emulator. " +
        'Android reads the grant state back; iOS has no read.',
    )
    .option('--slot <name>', 'Use this workspace device slot', parseDeviceSlotOption)
    .option('--json', 'print the result as JSON on stdout')
    .action(async (platform: string, action: string, service: string, opts: ToolOptions) =>
      finish(await runDeviceTool(parsePermissionRequest(platform, action, service), opts, deps)),
    );

  device
    .command('push')
    .argument('<platform>', 'ios')
    .description("Send a test push notification to the app on this workspace's own iOS simulator.")
    .requiredOption('--payload <json>', 'the APNs payload: a JSON object with an "aps" key, at most 4096 bytes')
    .option('--slot <name>', 'Use this workspace device slot', parseDeviceSlotOption)
    .option('--json', 'print the result as JSON on stdout')
    .action(async (platform: string, opts: ToolOptions) =>
      finish(await runDeviceTool(parsePushRequest(platform, opts), opts, deps)),
    );

  device
    .command('network')
    .argument('<platform>', 'android')
    .argument('<state>', 'on or off')
    .description("Turn Wi-Fi and mobile data on or off on this workspace's own Android emulator, and read them back.")
    .option('--slot <name>', 'Use this workspace device slot', parseDeviceSlotOption)
    .option('--json', 'print the result as JSON on stdout')
    .action(async (platform: string, state: string, opts: ToolOptions) =>
      finish(await runDeviceTool(parseNetworkRequest(platform, state), opts, deps)),
    );
}
