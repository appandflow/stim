import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { constants } from 'node:os';
import { dirname, join } from 'node:path';
import chalk from 'chalk';
import type { Command } from 'commander';
import { LOG_ROTATE_BYTES } from '@stim-cli/core';
import {
  agentActionGesture,
  agentSnapshotFile,
  hostedNativeRecords,
  parseAgentSnapshot,
  parseHostedNativePlacement,
  readAgentSnapshot,
  readDeviceIdleShutdowns,
  readIdleStop,
  workspaceAgentDeviceDir,
  workspaceLogsDir,
  type WorkspaceState,
} from '@stim-cli/core/state';
import type { PresencePublishParams } from '@stim-cli/core/protocol';
import { phaseLine, refuseNoProject } from '../command-output.ts';
import { runProcessOperation } from '../cli-operation.ts';
import { hostedAgentSessionName } from '../hosted-names.ts';
import { resolveOwnedAvdSerialAsync } from '../devices/android.ts';
import { deviceSlotKey, parseDeviceSlotKey, projectDeviceSlots } from '../devices/device-slots.ts';
import { deviceLeasePath, leaseIsExpired, parseLease, parseWorkspaceLeases } from '../engine/device-lease.ts';
import { getExecutor } from '../exec.ts';
import { requestLocalServer } from '../local-server.ts';
import { createNdjsonWriter } from '../ndjson.ts';
import { readWorkspaceLaunches } from '../supervisor/state.ts';
import { getProject, type ProjectRecord } from '../workspace/config.ts';
import { findCommandWorkspaceAsync } from '../workspace/project.ts';
import { readWorkspaceState } from '../workspace/workspace-state.ts';
import { repoRootAsync } from '../workspace/worktree.ts';

type Platform = 'ios' | 'android';

/** A device this workspace may drive: its owned simulator or emulator, a leased phone, or a hosted session. */
export interface WorkspaceDevice {
  platform: Platform;
  slot: string;
  kind: 'owned' | 'physical' | 'hosted';
  /** The UDID or serial; null for a hosted session, and for an owned emulator that is not running. */
  id: string | null;
  name: string | null;
  /** The owned emulator's AVD, which revive names it by. */
  avdName?: string;
  /** A hosted session's agent-device remote config; null when its host offers no agent control. */
  remoteConfig?: string | null;
}

export interface AgentDeviceRefusal {
  code: string;
  message: string;
  remedy: string;
}

export interface AgentDevicePlan {
  device: WorkspaceDevice;
  command: string | null;
  /** The element a targeted command acts on: its first positional. */
  target: string | undefined;
  /** The arguments agent-device gets: the agent's, without Stim's and agent-device's selection flags. */
  args: string[];
  /** The agent's own `--session`, if any. */
  session: string | undefined;
}

/** agent-device's device lifecycle commands; Stim boots devices only through admission. */
const REFUSED_COMMANDS: Record<string, string> = {
  boot: "Stim boots this workspace's devices itself, through admission. Run `stim revive` to boot it after an idle stop, or `stim ios|android` to boot it and launch the app.",
  shutdown:
    "Stim shuts this workspace's devices down itself. Run `stim stop` to stop the workspace and shut its device down, or `stim agent-device close` to end the session.",
};

/** agent-device 0.21.35's flags that take a separate value, so the value is neither the command nor its target. */
const AGENT_DEVICE_VALUE_FLAGS = new Set([
  '--config',
  '--level',
  '--timeout',
  '--depth',
  '-d',
  '--scope',
  '-s',
  '--count',
  '--interval-ms',
  '--hold-ms',
  '--jitter-px',
  '--settle-quiet',
  '--state-dir',
  '--pick',
  '--daemon-base-url',
]);

/** Commands that select a device but take no `--session`. */
const SESSIONLESS_COMMANDS = new Set(['device']);

/** agent-device 0.21.35's command names (`agent-device help commands`). */
const AGENT_DEVICE_COMMANDS = new Set(
  (
    'action-button alert app-switcher apps appstate artifacts audio auth back batch boot capabilities cdp click ' +
    'clipboard close connect connection daemon debug device devices diff disconnect doctor events fill find focus fold gesture ' +
    'get hardware-button help home hover install install-from-source is keyboard logs longpress mcp metro network ' +
    'long-press open orientation perf plugins prepare press proxy push react-devtools react-native record reinstall replay ' +
    'screenshot scroll session settings shutdown snapshot swipe takeover tap telephony test trace trigger-app-event ' +
    'tv-remote type uninstall viewport wait web'
  ).split(' '),
);

/**
 * The positions of the positional arguments, past the values of agent-device's value flags. The command is the
 * first known command name among them, so a value of a flag agent-device adds later cannot pass for it; a command
 * this list does not know yet falls back to the first positional.
 */
function positionals(rest: readonly string[]): number[] {
  const found: number[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] ?? '';
    if (AGENT_DEVICE_VALUE_FLAGS.has(arg)) i++;
    else if (!arg.startsWith('-')) found.push(i);
  }
  const known = found.findIndex((index) => AGENT_DEVICE_COMMANDS.has(rest[index] ?? ''));
  return known > 0 ? found.slice(known) : found;
}

/** Commands that take no device selection flags; agent-device refuses them with one. */
const UNSELECTED_COMMANDS = new Set([
  'help',
  'daemon',
  'auth',
  'plugins',
  'mcp',
  'proxy',
  'connection',
  'connect',
  'web',
  'disconnect',
]);

/** Commands whose first positional is the element they act on. */
const TARGETED_COMMANDS = new Set(['press', 'tap', 'click', 'fill', 'longpress', 'long-press', 'hover', 'focus']);

/** Commands agent-device records with a point. */
const POINT_COMMANDS = new Set([...TARGETED_COMMANDS, 'scroll', 'swipe']);

const VALUE_FLAGS = ['--platform', '--udid', '--serial', '--device', '--session', '--remote-config', '--slot'] as const;
type ValueFlag = (typeof VALUE_FLAGS)[number];

/** Whether the arguments only ask agent-device about itself, so they need no workspace. */
export function needsNoWorkspace(argv: readonly string[]): boolean {
  const [first] = argv;
  return first === undefined || ['--help', '-h', '--version', '-V', 'help'].includes(first);
}

function readFlags(argv: readonly string[]): { flags: Partial<Record<ValueFlag, string>>; rest: string[] } | string {
  const flags: Partial<Record<ValueFlag, string>> = {};
  const rest: string[] = [];
  const queue = [...argv];
  for (let arg = queue.shift(); arg !== undefined; arg = queue.shift()) {
    const flag = VALUE_FLAGS.find((name) => arg === name || arg.startsWith(`${name}=`));
    if (!flag) {
      rest.push(arg);
      continue;
    }
    const value = arg === flag ? queue.shift() : arg.slice(flag.length + 1);
    if (value === undefined || value === '') return `${flag} needs a value.`;
    flags[flag] = value;
  }
  return { flags, rest };
}

/** The arguments of a command that selects no device, such as `daemon status`, without Stim's flags; null otherwise. */
export function unselectedArgs(argv: readonly string[]): string[] | null {
  const read = readFlags(argv);
  if (typeof read === 'string') return null;
  const [at = -1] = positionals(read.rest);
  const command = read.rest[at];
  if (command === undefined || !UNSELECTED_COMMANDS.has(command)) return null;
  const session = read.flags['--session'];
  return [...read.rest, ...(session === undefined ? [] : ['--session', session])];
}

function refusal(code: string, message: string, remedy: string): { refusal: AgentDeviceRefusal } {
  return { refusal: { code, message, remedy } };
}

function describe(device: WorkspaceDevice): string {
  const what =
    device.kind === 'hosted'
      ? `hosted ${device.platform === 'ios' ? 'iOS simulator' : 'Android emulator'}`
      : device.kind === 'physical'
        ? `${device.platform === 'ios' ? 'iPhone' : 'Android phone'} ${device.id}`
        : `${device.platform === 'ios' ? 'simulator' : 'emulator'} ${device.id ?? device.avdName}`;
  return device.slot === 'default' ? what : `${what} (slot ${device.slot})`;
}

const KIND_ORDER: WorkspaceDevice['kind'][] = ['physical', 'hosted', 'owned'];

/**
 * Picks this workspace's device for an agent-device command. `--slot` picks the slot, `--platform` the platform
 * when the slot has both; a phone the workspace leases is preferred to its hosted or owned device. A named UDID,
 * serial, device name or remote config must be one of the workspace's, and `boot` is refused.
 */
export function planAgentDevice(
  devices: readonly WorkspaceDevice[],
  argv: readonly string[],
): AgentDevicePlan | { refusal: AgentDeviceRefusal } {
  const read = readFlags(argv);
  if (typeof read === 'string') return refusal('STIM_BAD_ARG', read, 'Pass the flag with its value.');
  const { flags, rest } = read;
  const [at = -1, next = -1] = positionals(rest);
  const command = rest[at] ?? null;
  const refused =
    command === null
      ? undefined
      : command === 'close' && rest.includes('--shutdown')
        ? REFUSED_COMMANDS.shutdown
        : REFUSED_COMMANDS[command];
  if (refused) {
    return refusal(
      'STIM_BAD_ARG',
      `stim agent-device does not run ${command}: Stim owns the lifecycle of this workspace's devices.`,
      refused,
    );
  }
  const slot = flags['--slot'] ?? 'default';
  const asked = flags['--platform'];
  const platform = asked === 'apple' ? 'ios' : asked;
  if (platform !== undefined && platform !== 'ios' && platform !== 'android') {
    return refusal(
      'STIM_BAD_ARG',
      `stim agent-device drives this workspace's iOS and Android devices, not --platform ${asked}.`,
      'Pass --platform ios or --platform android, or leave it out.',
    );
  }
  const where = slot === 'default' ? '' : ` in slot ${slot}`;
  const listed = devices.map(describe).join(', ') || 'none';
  let candidates = devices.filter((device) => device.slot === slot && (!platform || device.platform === platform));
  const named = flags['--udid'] ?? flags['--serial'];
  if (named !== undefined) {
    candidates = candidates.filter((device) => device.id === named);
    if (!candidates.length) {
      return refusal(
        'STIM_BAD_ARG',
        `${named} is not a device of this workspace${where}; stim agent-device drives only its own devices (${listed}).`,
        'Leave out --udid and --serial: stim agent-device selects the workspace device itself. Use --slot or --platform to pick another of its devices.',
      );
    }
  }
  const name = flags['--device'];
  if (name !== undefined) {
    candidates = candidates.filter((device) => device.name === name);
    if (!candidates.length) {
      return refusal(
        'STIM_BAD_ARG',
        `${name} is not a device of this workspace${where}; stim agent-device drives only its own devices (${listed}).`,
        'Leave out --device: stim agent-device selects the workspace device itself.',
      );
    }
  }
  if (!candidates.length) {
    return refusal(
      'STIM_NO_DEVICE',
      `This workspace has no ${platform ? `${platform} ` : ''}device${where} for agent-device to drive (its devices: ${listed}).`,
      `Run \`stim ${platform ?? 'ios|android'}${slot === 'default' ? '' : ` --slot ${slot}`}\` first.`,
    );
  }
  if (new Set(candidates.map((device) => device.platform)).size > 1) {
    return refusal(
      'STIM_BAD_ARG',
      `This workspace has both an iOS and an Android device${where}.`,
      'Pass --platform ios or --platform android.',
    );
  }
  const [device] = candidates.toSorted((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
  if (!device)
    return refusal('STIM_NO_DEVICE', 'This workspace has no device to drive.', 'Run `stim ios|android` first.');
  const config = flags['--remote-config'];
  if (config !== undefined && (device.kind !== 'hosted' || config !== device.remoteConfig)) {
    return refusal(
      'STIM_BAD_ARG',
      `${config} is not the agent-device remote config of this workspace's device.`,
      "Leave out --remote-config: stim agent-device passes the hosted session's config itself.",
    );
  }
  const second = rest[next];
  return {
    device,
    command,
    target:
      command && TARGETED_COMMANDS.has(command) && second !== undefined && !second.startsWith('-') ? second : undefined,
    args: rest,
    session: flags['--session'],
  };
}

/**
 * The session name when the agent names none. A hosted session's name carries the workspace id because agent-device
 * keeps one saved remote connection per name for the whole machine; a local device's sessions live in the workspace's
 * own state directory.
 */
function defaultSessionName(root: string, device: WorkspaceDevice): string {
  return device.kind === 'hosted'
    ? hostedAgentSessionName(root, device.platform, device.slot)
    : `stim-${device.slot}-${device.platform}`;
}

/**
 * The full agent-device arguments for a plan: the selection for a local device or the hosted session's remote config,
 * with `stim-<slot>-<platform>` (`-<workspace id>` for a hosted session) as the session when the agent names none.
 * Refuses a device that is not running.
 */
export function agentDeviceArgs(
  plan: AgentDevicePlan,
  root: string,
): { args: string[]; session: string | null } | { refusal: AgentDeviceRefusal } {
  const { device } = plan;
  const sessionless = plan.command !== null && SESSIONLESS_COMMANDS.has(plan.command);
  const name = plan.session ?? defaultSessionName(root, device);
  if (device.kind === 'hosted') {
    if (!device.remoteConfig) {
      return refusal(
        'STIM_NO_DEVICE',
        `The host of this workspace's ${describe(device)} offers no agent control.`,
        'On the hosting Mac, set `hosting.agentDriver` to `agent-device` and install agent-device 0.21.30 or later, then rerun `stim ios|android --remote <machine>`.',
      );
    }
    return {
      args: [...plan.args, ...(sessionless ? [] : ['--session', name]), '--remote-config', device.remoteConfig],
      session: null,
    };
  }
  if (device.id === null) {
    return refusal(
      'STIM_NO_DEVICE',
      `This workspace's ${describe(device)} is not running.`,
      `Run \`stim ${device.platform}${device.slot === 'default' ? '' : ` --slot ${device.slot}`}\` to boot it and launch the app.`,
    );
  }
  return {
    args: [
      ...plan.args,
      '--platform',
      device.platform,
      device.platform === 'ios' ? '--udid' : '--serial',
      device.id,
      ...(sessionless ? [] : ['--session', name]),
    ],
    session: sessionless ? null : name,
  };
}

function liveLease(platform: Platform, id: string, token: string, now: number): { name: string | null } | null {
  try {
    const lease = parseLease(readFileSync(deviceLeasePath(platform, id), 'utf8'));
    return lease && lease.token === token && !leaseIsExpired(lease, now) ? { name: lease.deviceName } : null;
  } catch {
    return null;
  }
}

/** This workspace's devices from its config and state alone, without asking simctl or adb. */
export function workspaceDevices(
  project: ProjectRecord | null,
  state: WorkspaceState | null,
  now: number = Date.now(),
): WorkspaceDevice[] {
  const devices: WorkspaceDevice[] = [];
  for (const { slot, platforms } of projectDeviceSlots(project)) {
    const ios = platforms.ios;
    if (ios?.owned && typeof ios.deviceUdid === 'string') {
      devices.push({ platform: 'ios', slot, kind: 'owned', id: ios.deviceUdid, name: ios.deviceName ?? null });
    }
    const android = platforms.android;
    if (android?.owned && typeof android.avdName === 'string') {
      devices.push({
        platform: 'android',
        slot,
        kind: 'owned',
        id: null,
        name: android.avdName,
        avdName: android.avdName,
      });
    }
  }
  for (const platform of ['ios', 'android'] as const) {
    for (const [slot, raw] of Object.entries(hostedNativeRecords(state, platform))) {
      const placement = parseHostedNativePlacement(raw, platform);
      if (!placement) continue;
      const remoteConfig = 'remoteConfig' in placement.agent ? placement.agent.remoteConfig : null;
      const local = devices.filter((device) => device.platform === platform && device.slot === slot);
      for (const device of local) devices.splice(devices.indexOf(device), 1);
      devices.push({ platform, slot, kind: 'hosted', id: null, name: null, remoteConfig });
    }
  }
  for (const [key, record] of Object.entries(parseWorkspaceLeases(state?.deviceLeases))) {
    const parsed = parseDeviceSlotKey(key);
    if (!parsed) continue;
    const lease = liveLease(parsed.platform, record.id, record.token, now);
    if (lease) devices.push({ ...parsed, kind: 'physical', id: record.id, name: lease.name });
  }
  return devices;
}

/** Whether the selected device needs `stim revive` first: Metro or the device itself was stopped for being idle. */
export function needsRevive(
  project: ProjectRecord | null,
  state: WorkspaceState | null,
  device: WorkspaceDevice,
): boolean {
  if (device.kind !== 'owned') return false;
  if (readIdleStop(state) && typeof project?.metroPort === 'number') return true;
  return deviceSlotKey(device.platform, device.slot) in readDeviceIdleShutdowns(state);
}

async function resolveDevices(root: string, project: ProjectRecord | null, state: WorkspaceState | null) {
  const devices = workspaceDevices(project, state);
  const launches = readWorkspaceLaunches(root);
  for (const device of devices) {
    if (device.platform !== 'android' || device.kind !== 'owned' || !device.avdName) continue;
    const recorded = launches[deviceSlotKey('android', device.slot)]?.deviceId;
    const resolved = await resolveOwnedAvdSerialAsync(device.avdName, recorded ? { preferredSerial: recorded } : {});
    device.id = resolved.serial ?? null;
  }
  return devices;
}

interface EventsCursor {
  [path: string]: number;
}

function eventsFiles(sessionsDir: string): string[] {
  try {
    return readdirSync(sessionsDir).map((name) => join(sessionsDir, name, 'events.ndjson'));
  } catch {
    return [];
  }
}

function sizeOf(path: string): number {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    return fstatSync(fd).size;
  } catch {
    return 0;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function eventsCursor(sessionsDir: string): EventsCursor {
  return Object.fromEntries(eventsFiles(sessionsDir).map((path) => [path, sizeOf(path)]));
}

/** The `action.recorded` details agent-device appended for `session` since `cursor`. */
export function recordedSince(
  sessionsDir: string,
  cursor: EventsCursor,
  session: string,
): { command: string; details: unknown }[] {
  const found: { command: string; details: unknown }[] = [];
  for (const path of eventsFiles(sessionsDir)) {
    const start = cursor[path] ?? 0;
    const size = sizeOf(path);
    if (size <= start) continue;
    let fd: number | undefined;
    let text = '';
    try {
      fd = openSync(path, 'r');
      const buffer = Buffer.alloc(size - start);
      text = buffer.toString('utf8', 0, readSync(fd, buffer, 0, buffer.length, start));
    } catch {
      continue;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    for (const line of text.split('\n')) {
      let event: { kind?: unknown; session?: unknown; command?: unknown; details?: unknown };
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event?.kind === 'action.recorded' && event.session === session && typeof event.command === 'string')
        found.push({ command: event.command, details: event.details });
    }
  }
  return found;
}

function writeSnapshot(root: string, session: string, text: string): void {
  const tree = parseAgentSnapshot(text);
  if (!tree) return;
  const file = agentSnapshotFile(root, session);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(tmp, JSON.stringify(tree));
    renameSync(tmp, file);
  } catch {
    rmSync(tmp, { force: true });
  }
}

const MIN_VERSION = [0, 21, 30] as const;
const RECORD_WAIT_MS = 300;
const PUBLISH_TIMEOUT_MS = 1500;
const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;

function agentDeviceVersion(script: string | undefined, command: string): string | null {
  const file = script ? join(dirname(script), '..', 'package.json') : null;
  if (file) {
    try {
      const version = JSON.parse(readFileSync(file, 'utf8'))?.version;
      if (typeof version === 'string') return version;
    } catch {}
  }
  return getExecutor().runFileQuiet(command, ['--version'], { timeoutMs: 10_000 });
}

function versionAtLeast(version: string | null): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version?.trim() ?? '');
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  const [wantMajor, wantMinor, wantPatch] = MIN_VERSION;
  if (major !== wantMajor) return Number(major) > wantMajor;
  if (minor !== wantMinor) return Number(minor) > wantMinor;
  return Number(patch) >= wantPatch;
}

function refuse(found: AgentDeviceRefusal, json: boolean): void {
  if (json) console.log(JSON.stringify(found));
  console.error(chalk.red(phaseLine('error', `${found.code}: ${found.message}`)));
  console.error(phaseLine('remedy', found.remedy));
  process.exitCode = 1;
}

function publish(version: string, params: PresencePublishParams): Promise<void> {
  return requestLocalServer('presence.publish', params, { version, timeoutMs: PUBLISH_TIMEOUT_MS }).then(
    () => undefined,
    () => undefined,
  );
}

/** The terminal already sends SIGINT to agent-device, in the same foreground process group; Stim only outlives it. */
const FORWARDED_SIGNALS = ['SIGTERM', 'SIGHUP'] as const;
const COMMAND_NAME = /^[a-z][a-z0-9-]{0,31}$/;

async function runAgentDevice(argv: string[], version: string): Promise<void> {
  const json = argv.includes('--json');
  const { resolveAgentDevice } = await import('@stim-cli/core');
  let invocation: { command: string; args: string[] };
  try {
    invocation = resolveAgentDevice(process.env);
  } catch (error) {
    return refuse(
      {
        code: 'STIM_NO_DEVICE',
        message: (error instanceof Error ? error.message : String(error)).replace(/ on the hosting Mac/g, ''),
        remedy: 'npm install --global --prefix "$HOME/.local" agent-device',
      },
      json,
    );
  }
  const found = agentDeviceVersion(invocation.args[0], invocation.command);
  if (!versionAtLeast(found)) {
    return refuse(
      {
        code: 'STIM_NO_DEVICE',
        message: `stim agent-device needs agent-device ${MIN_VERSION.join('.')} or later; found ${found?.trim() || 'no readable version'}.`,
        remedy: 'npm install --global --prefix "$HOME/.local" agent-device@latest',
      },
      json,
    );
  }
  if (needsNoWorkspace(argv)) return execute(invocation, argv, null, null, version);
  const root = await findCommandWorkspaceAsync(process.cwd(), repoRootAsync, (line) => console.error(line));
  if (!root) return refuseNoProject({ json });
  const unselected = unselectedArgs(argv);
  if (unselected) return execute(invocation, unselected, null, root, version);
  let project = getProject(root);
  let state = readWorkspaceState(root);
  let plan = planAgentDevice(await resolveDevices(root, project, state), argv);
  if ('refusal' in plan) return refuse(plan.refusal, json);
  if (needsRevive(project, state, plan.device)) {
    const failed = await revive(root, plan.device);
    if (failed) return refuse(failed, json);
    project = getProject(root);
    state = readWorkspaceState(root);
    plan = planAgentDevice(await resolveDevices(root, project, state), argv);
    if ('refusal' in plan) return refuse(plan.refusal, json);
  }
  const built = agentDeviceArgs(plan, root);
  if ('refusal' in built) return refuse(built.refusal, json);
  await execute(invocation, argv, { plan, ...built }, root, version);
}

async function revive(root: string, device: WorkspaceDevice): Promise<AgentDeviceRefusal | null> {
  console.error(
    `stim agent-device: reviving this workspace's ${device.platform === 'ios' ? 'simulator' : 'emulator'} after its idle stop.`,
  );
  try {
    const { beforeCommand } = await import('../daemon/client.ts');
    await beforeCommand('revive');
  } catch {}
  const { runRevive, reviveDeps, reviveLines } = await import('./revive.ts');
  const { value: result, interrupted } = await runProcessOperation(root, (context) =>
    runRevive({
      root,
      note: (line) => console.error(line),
      requestedDevice: device.platform === 'ios' ? device.id : (device.avdName ?? null),
      deps: reviveDeps(context),
    }),
  );
  if (interrupted !== null) process.exit(interrupted);
  if (!result.ok)
    return {
      code: result.error.code,
      message: result.error.message,
      remedy: result.error.remedy ?? 'Run `stim revive` and follow its remedy.',
    };
  for (const line of reviveLines(result.facts, Date.now())) console.error(line);
  return null;
}

interface Run {
  plan: AgentDevicePlan;
  args: string[];
  session: string | null;
}

const SESSION_LOST =
  /Error \(SESSION_NOT_FOUND\)|"code":\s*"SESSION_NOT_FOUND"|requires an active app session on the target device|No active proxy device lease for this session/;

function lostSession(exit: AgentDeviceExit): boolean {
  const text = `${exit.stdout}${exit.stderr}`;
  return exit.signal === null && exit.code !== 0 && SESSION_LOST.test(text) && !NO_AGENT_CONTROL.test(text);
}

const NO_AGENT_CONTROL = /has no agent control for this hosted session/;

/** Single-action commands that did nothing when they answered that the session was gone, so running them again is safe. */
const REOPENABLE_COMMANDS = new Set(
  'snapshot screenshot press tap click scroll swipe longpress long-press type fill back home get is find wait hover focus'.split(
    ' ',
  ),
);

function hostedReopen(root: string, plan: AgentDevicePlan, args: readonly string[]): string[] | null {
  const { device } = plan;
  if (device.kind !== 'hosted' || !device.remoteConfig || !plan.command || !REOPENABLE_COMMANDS.has(plan.command))
    return null;
  if (args.includes('--text-stdin')) return null;
  const appId = readWorkspaceLaunches(root)[deviceSlotKey(device.platform, device.slot)]?.appId;
  if (!appId) return null;
  const session = plan.session ?? defaultSessionName(root, device);
  return ['open', appId, '--session', session, '--remote-config', device.remoteConfig];
}

interface AgentDeviceExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** What agent-device printed, when the run was captured instead of passed through. */
  stdout: Buffer;
  stderr: Buffer;
}

/**
 * Runs agent-device with this terminal's stdin. `tee` also hands its stdout to `onStdout`; `capture` keeps both
 * streams instead of passing them through.
 */
async function spawnAgentDevice(
  invocation: { command: string; args: string[] },
  args: string[],
  env: NodeJS.ProcessEnv,
  mode: { tee?: boolean; capture?: boolean } = {},
  onStdout: (chunk: Buffer) => void = () => {},
): Promise<AgentDeviceExit> {
  const child = getExecutor().spawn(invocation.command, [...invocation.args, ...args], {
    stdio: ['inherit', mode.tee || mode.capture ? 'pipe' : 'inherit', mode.capture ? 'pipe' : 'inherit'],
    env,
  });
  const handlers = [
    ...FORWARDED_SIGNALS.map((signal) => [signal, () => child.kill(signal)] as const),
    ['SIGINT', () => {}] as const,
  ];
  for (const [signal, handler] of handlers) process.on(signal, handler);
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  if (mode.tee && child.stdout) {
    process.stdout.on('error', () => {});
    child.stdout.pipe(process.stdout, { end: false });
    child.stdout.on('data', onStdout);
  }
  if (mode.capture) {
    child.stdout?.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => err.push(chunk));
  }
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('error', (error) => {
      console.error(chalk.red(phaseLine('error', `agent-device could not start: ${error.message}`)));
      resolve({ code: 127, signal: null });
    });
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  for (const [signal, handler] of handlers) process.off(signal, handler);
  return { ...exit, stdout: Buffer.concat(out), stderr: Buffer.concat(err) };
}

async function execute(
  invocation: { command: string; args: string[] },
  argv: string[],
  run: Run | null,
  root: string | null,
  version: string,
): Promise<void> {
  const local = root !== null && run?.plan.device.kind !== 'hosted';
  const env = { ...process.env, ...(local ? { AGENT_DEVICE_STATE_DIR: workspaceAgentDeviceDir(root) } : {}) };
  const sessionsDir = root ? join(workspaceAgentDeviceDir(root), 'sessions') : null;
  const command = run?.plan.command ?? null;
  const tracked =
    root && run?.session && sessionsDir && command && COMMAND_NAME.test(command)
      ? { root, session: run.session, sessionsDir, command, device: run.plan.device }
      : null;
  const cursor = tracked ? eventsCursor(tracked.sessionsDir) : {};
  const hosted =
    root && run?.plan.device.kind === 'hosted' && command && COMMAND_NAME.test(command)
      ? { root, device: run.plan.device, command }
      : null;
  const shown = tracked ?? hosted;
  const target: Omit<PresencePublishParams, 'command' | 'phase'> | null = shown
    ? {
        workspace: shown.root,
        platform: shown.device.platform,
        ...(shown.device.slot === 'default' ? {} : { slot: shown.device.slot }),
        ...(shown.device.kind === 'physical' ? { physical: true } : {}),
      }
    : null;
  const started = target && command ? publish(version, { ...target, command, phase: 'start' }) : null;
  const tee = Boolean(tracked) && command === 'snapshot' && argv.includes('--json') && !process.stdout.isTTY;
  const args = run?.args ?? argv;
  const reopen = run && hosted ? hostedReopen(hosted.root, run.plan, args) : null;
  const chunks: Buffer[] = [];
  let bytes = 0;
  const onStdout = (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes <= MAX_SNAPSHOT_BYTES) chunks.push(chunk);
  };
  let exit = await spawnAgentDevice(invocation, args, env, { tee, capture: reopen !== null }, onStdout);
  if (reopen && lostSession(exit)) {
    console.error(
      phaseLine('agent-device', `the host no longer holds this agent-device session; opening ${reopen[1]} again`),
    );
    const opened = await spawnAgentDevice(invocation, reopen, env, { capture: true });
    if (opened.code === 0) exit = await spawnAgentDevice(invocation, args, env, { capture: true });
    else exit = opened.signal === null ? { ...exit, stderr: Buffer.concat([exit.stderr, opened.stderr]) } : opened;
  }
  if (reopen) {
    process.stdout.on('error', () => {});
    process.stderr.on('error', () => {});
    process.stdout.write(exit.stdout);
    process.stderr.write(exit.stderr);
  }
  process.exitCode = exit.signal ? 128 + (constants.signals[exit.signal] ?? 0) : (exit.code ?? 1);
  if (hosted && target) {
    const directory = workspaceLogsDir(hosted.root);
    if (AGENT_DEVICE_COMMANDS.has(hosted.command) && existsSync(directory)) {
      const failed = exit.code !== 0 || exit.signal !== null;
      const writer = createNdjsonWriter(join(directory, 'hosted-agent.ndjson'), { maxBytes: LOG_ROTATE_BYTES });
      writer.write({
        src: 'agent',
        level: failed ? 'error' : 'info',
        event: failed ? 'agent_failed' : 'agent_action',
        msg: `Hosted agent-device ${hosted.command} ${failed ? 'failed' : 'finished'}`,
        command: hosted.command,
        platform: hosted.device.platform,
        ...(target.slot === undefined ? {} : { slot: target.slot }),
      });
      writer.close();
    }
    await started;
    return publish(version, { ...target, command: hosted.command, phase: 'end' });
  }
  if (!tracked || !target || !run) return;
  if (tee && bytes <= MAX_SNAPSHOT_BYTES)
    writeSnapshot(tracked.root, tracked.session, Buffer.concat(chunks).toString('utf8'));
  let records = recordedSince(tracked.sessionsDir, cursor, tracked.session);
  if (!records.length && exit.code === 0 && POINT_COMMANDS.has(tracked.command)) {
    await new Promise((resolve) => setTimeout(resolve, RECORD_WAIT_MS));
    records = recordedSince(tracked.sessionsDir, cursor, tracked.session);
  }
  const tree = records.length ? readAgentSnapshot(tracked.root, tracked.session) : null;
  const ended = records.flatMap(({ command: recorded, details }) => {
    if (!COMMAND_NAME.test(recorded)) return [];
    const gesture = agentActionGesture(
      details,
      tree,
      recorded === tracked.command || records.length === 1 ? run.plan.target : undefined,
    );
    return gesture ? [{ command: recorded, gesture }] : [];
  });
  await started;
  if (!ended.length) await publish(version, { ...target, command: tracked.command, phase: 'end' });
  for (const { command: recorded, gesture } of ended)
    await publish(version, { ...target, command: recorded, phase: 'end', gesture });
}

export default function agentDeviceCommand(program: Command, version: string): void {
  program.enablePositionalOptions();
  program
    .command('agent-device')
    .description(
      "Run agent-device on this workspace's device: Stim passes the platform, device, session and state directory, revives an idle workspace first, and shows each action to stim-server viewers. Arguments are agent-device's own.",
    )
    .helpOption(false)
    .allowUnknownOption()
    .allowExcessArguments()
    .passThroughOptions()
    .argument('[args...]')
    .action(async () => {
      const index = process.argv.indexOf('agent-device');
      await runAgentDevice(process.argv.slice(index + 1), version);
    });
}
