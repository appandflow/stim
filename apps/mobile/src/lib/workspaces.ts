import { t } from '@lingui/core/macro';

import { machineName } from '@/lib/format';
import type {
  AndroidState,
  AppPresence,
  BuildReport,
  DeviceActivity,
  DeviceAppProcess,
  DevicePlatform,
  EnvironmentState,
  PhysicalDeviceState,
  SimState,
  StatusIssue,
  WebBrowserState,
} from '@/protocol/types';

export function isActive(env: EnvironmentState): boolean {
  return (
    env.live ||
    env.build?.state === 'running' ||
    env.macos?.build.state === 'running' ||
    env.macos?.state === 'running' ||
    env.macos?.state === 'orphaned' ||
    devicesOf(env).some((device) => device.host && device.running) ||
    (env.remoteDevices?.length ?? 0) > 0 ||
    (env.physicalDevices?.length ?? 0) > 0
  );
}

/** A workspace `stim worktree warm` is preparing, or has prepared and nothing has run in yet. */
export function isSettingUp(env: EnvironmentState): boolean {
  return !env.live && (env.phase === 'warming' || env.phase === 'ready');
}

/** Whether the home list shows the workspace under Live: it is active or being set up. */
export function isShownLive(env: EnvironmentState): boolean {
  return isActive(env) || isSettingUp(env);
}

export interface DeviceRef {
  platform: DevicePlatform;
  slot: string;
  id: string | null;
  name: string;
  model: string;
  state: string;
  running: boolean;
  owned: boolean;
  physical: boolean;
  activity?: DeviceActivity;
  app?: DeviceAppProcess;
  /** The app presence `stim` reported on the device record; read only when the environment carries `stage`. */
  presence?: AppPresence;
  /** The AVD's device profile id, such as `pixel_9`, for an Android emulator. */
  profile?: string | null;
  /** The Stim-owned Chrome's current page and, when its latest load failed, why. */
  page?: { url: string; error: string | null };
  /** Bytes the device's data holds, when status measures it. */
  diskBytes?: number | null;
  /** When the workspace's lease on a physical device ends. */
  leaseExpiresAt?: string;
  /** The Mac a hosted device or app runs on, without the entry's port. */
  host?: string;
}

export function deviceKey(device: Pick<DeviceRef, 'platform' | 'slot' | 'physical'>): string {
  return `${device.platform}\n${device.slot}${device.physical ? '\nphysical' : ''}`;
}

type ServedDevice = Pick<DeviceRef, 'platform' | 'owned' | 'physical' | 'running' | 'state' | 'host'>;

/**
 * Whether stim-server serves the device's screen: an owned one, or a connected physical device whose platform the
 * Mac's stim-server lists in its hello `features` (`physical-ios`, view only, or `physical-android`). An older server
 * ignores `physical` and would stream the slot's owned device instead. `features` is null while the Mac is not
 * connected, when nothing streams and the tile waits for it like any other.
 */
export function streamsFrames(device: ServedDevice, features: readonly string[] | null): boolean {
  if (device.host && (device.platform === 'ios' || device.platform === 'android'))
    return device.state !== 'stopped' && (features === null || features.includes(`${device.platform}-hosted`));
  if (device.platform === 'macos') return device.running && (features === null || features.includes('macos-window'));
  if (!device.physical) return device.owned;
  return device.running && (features === null || features.includes(`physical-${device.platform}`));
}

/** Why a device {@link streamsFrames} does not serve shows no screen. */
export function unservedReason(device: ServedDevice): string {
  if (device.host && (device.platform === 'ios' || device.platform === 'android'))
    return device.state === 'stopped' ? t`Not running` : t`Update stim-server on the Mac to see this device's screen.`;
  if (device.platform === 'macos') return t`Update stim-server on the Mac to view this app window.`;
  if (!device.physical) return t`Frames are only served for devices Stim owns.`;
  if (!device.running) return device.state;
  return t`Update stim-server on the Mac to see this device's screen.`;
}

function iosDevice(slot: string, sim: SimState): DeviceRef {
  const model = /\(([^()]*(?:\([^()]*\)[^()]*)*)\)\s*$/.exec(sim.name ?? '')?.[1] ?? t`iOS Simulator`;
  return {
    platform: 'ios',
    slot,
    id: sim.host ? null : sim.udid,
    name: sim.name ?? sim.udid,
    model: sim.host?.device ? `${sim.host.device.name} ${sim.host.device.runtime.replace(/^iOS /, '')}` : model,
    host: sim.host ? machineName(sim.host.machine) : undefined,
    state: sim.state,
    running: sim.host ? sim.state === 'ready' : sim.state === 'Booted',
    owned: sim.owned,
    physical: false,
    activity: sim.activity,
    app: sim.app,
    presence: sim.appPresence,
    diskBytes: sim.disk?.bytes ?? null,
  };
}

function androidDevice(slot: string, avd: AndroidState): DeviceRef {
  const state =
    avd.state && ['detected', 'not-detected', 'missing', 'unknown'].includes(avd.state) ? avd.state : t`unknown`;
  return {
    platform: 'android',
    slot,
    id: avd.host ? null : (avd.serial ?? null),
    name: avd.name ?? avd.serial ?? t`Android device`,
    model: avd.host?.device?.name ?? (avd.physical ? t`Android device` : t`Android Emulator`),
    host: avd.host ? machineName(avd.host.machine) : undefined,
    state: avd.host ? (avd.state ?? state) : state,
    running: avd.host ? avd.state === 'ready' : avd.state === 'detected',
    owned: avd.owned,
    physical: avd.physical,
    activity: avd.activity,
    app: avd.app,
    presence: avd.appPresence,
    profile: avd.deviceProfile,
    diskBytes: avd.disk?.bytes ?? null,
  };
}

function physicalDevice(device: PhysicalDeviceState & { platform: DevicePlatform }): DeviceRef {
  return {
    platform: device.platform,
    slot: device.slot,
    id: device.id,
    name: device.name ?? device.id,
    model: device.model ?? (device.platform === 'ios' ? t`iOS device` : t`Android device`),
    state: ['connected', 'disconnected', 'unknown'].includes(device.connection) ? device.connection : t`unknown`,
    running: device.connection === 'connected',
    owned: false,
    physical: true,
    leaseExpiresAt: device.lease.expiresAt,
  };
}

function webDevice(web: WebBrowserState): DeviceRef {
  const url = web.page?.route ?? web.page?.url ?? web.url;
  return {
    platform: 'web',
    slot: 'default',
    id: web.targetId ?? null,
    name: shortUrl(url),
    model: t`Web`,
    state: web.running ? t`running` : t`closed`,
    running: web.running,
    owned: true,
    physical: false,
    activity: web.activity,
    page: {
      url,
      error: web.running && web.page?.state === 'failed' ? (web.page.error ?? t`The page failed to load.`) : null,
    },
  };
}

export function platformName(platform: string): string {
  if (platform === 'macos') return 'macOS';
  return platform === 'ios' ? 'iOS' : platform === 'web' ? t`Web` : platform === 'android' ? t`Android` : t`Unknown`;
}

export function deviceSource(device: DeviceRef): string {
  if (device.platform === 'macos') return t`macOS app`;
  if (device.platform === 'web') return t`Chrome`;
  if (device.platform === 'ios') return device.physical ? t`iOS device` : t`iOS Simulator`;
  return device.physical ? t`Android device` : t`Android Emulator`;
}

export function shortUrl(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

export function devicesOf(env: EnvironmentState): DeviceRef[] {
  const out: DeviceRef[] = [];
  const add = (slot: string, ios?: SimState | null, android?: AndroidState | null) => {
    if (ios) out.push(iosDevice(slot, ios));
    if (android) out.push(androidDevice(slot, android));
  };
  add('default', env.ios, env.android);
  if (env.web) out.push(webDevice(env.web));
  if (env.macos)
    out.push({
      platform: 'macos',
      slot: 'default',
      id: env.macos.launchId,
      name: env.macos.product,
      model: 'macOS',
      state: env.macos.state,
      running: env.macos.state === 'running',
      owned: true,
      physical: false,
      host: env.macos.host ? machineName(env.macos.host.machine) : undefined,
    });
  for (const slot of env.slots ?? []) add(slot.slot, slot.ios, slot.android);
  for (const device of env.physicalDevices ?? []) {
    if (device.platform === 'ios' || device.platform === 'android')
      out.push(physicalDevice({ ...device, platform: device.platform }));
  }
  return out;
}

export function livePlatforms(env: EnvironmentState): DevicePlatform[] {
  return [
    ...new Set(
      devicesOf(env)
        .filter((d) => d.running && (d.owned || d.host) && !d.physical)
        .map((d) => d.platform),
    ),
  ];
}

export function runningBuild(
  env: EnvironmentState,
  device?: Pick<DeviceRef, 'platform' | 'slot'> & { physical?: boolean },
): BuildReport | null {
  const build = env.build;
  if (!build || build.state !== 'running' || device?.physical) return null;
  if (device && (build.platform !== device.platform || build.slot !== device.slot)) return null;
  return build;
}

const PLATFORM_RANK: Record<DevicePlatform, number> = { ios: 0, android: 1, web: 2, macos: 3 };
const platformRank = (d: DeviceRef) => (d.physical ? 4 : PLATFORM_RANK[d.platform]);

/**
 * Running devices before stopped ones, then iOS, Android, Web and physical devices, then by slot name. The order
 * never depends on activity or drivers, so a device keeps its place while tools attach and detach.
 */
export function orderDevices(devices: DeviceRef[]): DeviceRef[] {
  return [...devices].sort(
    (a, b) =>
      Number(b.running) - Number(a.running) || platformRank(a) - platformRank(b) || a.slot.localeCompare(b.slot),
  );
}

/**
 * Attaches each warning to the device whose name it mentions, the longest name winning so an AVD named after
 * another (`stim-app` and `stim-app-ipad`) keeps its own warnings. Warnings that name no device stay general.
 */
export function deviceWarnings(
  warnings: string[],
  devices: DeviceRef[],
): { byDevice: Map<DeviceRef, string[]>; general: string[] } {
  const byDevice = new Map<DeviceRef, string[]>();
  const general: string[] = [];
  for (const warning of warnings) {
    const device = devices
      .filter((d) => d.name && warning.includes(d.name))
      .reduce<DeviceRef | null>((best, d) => (best === null || d.name.length > best.name.length ? d : best), null);
    if (device) byDevice.set(device, [...(byDevice.get(device) ?? []), warning]);
    else general.push(warning);
  }
  return { byDevice, general };
}

export interface AttentionItem {
  message: string;
  severity: Exclude<StatusIssue['severity'], 'info'>;
  remedy: string | null;
  /** `remedy` as a line to paste in a terminal, `cd` into the workspace included. */
  command: string | null;
}

export interface AttentionGroup {
  path: string;
  live: boolean;
  items: AttentionItem[];
}

const slotMessage = (slot: string, message: string) => t`${slot}: ${message}`;

const shellQuote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

/**
 * The workspaces with something to fix: live ones first, then those with an error, each in status order. Items come
 * from `issues` other than `info` notes, or from the `warnings` text when the Mac's `stim` reports no issues.
 */
export function attentionGroups(environments: EnvironmentState[]): AttentionGroup[] {
  const groups = environments.flatMap((env): AttentionGroup[] => {
    const items: AttentionItem[] = env.issues
      ? env.issues.flatMap((issue) =>
          issue.severity === 'info'
            ? []
            : [
                {
                  message: issue.slot ? slotMessage(issue.slot, issue.message) : issue.message,
                  severity: issue.severity === 'error' ? 'error' : 'warning',
                  remedy: issue.remedy,
                  command: `cd ${shellQuote(issue.workspace)} && ${issue.remedy}`,
                },
              ],
        )
      : env.warnings.map((message) => ({ message, severity: 'warning', remedy: null, command: null }));
    return items.length ? [{ path: env.path, live: env.live, items }] : [];
  });
  const rank = (g: AttentionGroup) => (g.live ? 0 : 2) + (g.items.some((i) => i.severity === 'error') ? 0 : 1);
  return groups.sort((a, b) => rank(a) - rank(b));
}
