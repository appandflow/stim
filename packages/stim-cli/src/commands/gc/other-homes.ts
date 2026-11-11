import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { StimContext } from '@stim-cli/core';
import { readCreatedDevices, readJsonObject, readStimHomes, type StimHomeEntry } from '@stim-cli/core/state';
import chalk from 'chalk';
import { formatLongDuration, plural, quotedPath, shortUdid } from '../../command-output.ts';
import type { IosSimRecord } from '../../devices/ios.ts';
import { forgetStimHomes, isTrackedStimHome, stimHomesRoot } from '../../engine/stim-home-registry.ts';
import { formatBytes, isAbsentPath, isOnMountedVolume } from '../../fs-util.ts';
import { measureTree } from '../../private-size.ts';
import { nativeCanonicalPath, repoRootAsync, resolveSourceCheckoutAsync } from '../../workspace/worktree.ts';
import { unverifiedDeviceCommand } from './devices.ts';
import { describeError } from './eas-sessions.ts';
import { mapLimited, sizeConcurrency } from './limited.ts';
import { canonicalPath } from './paths.ts';
import { GC_OUTPUT, type GcOutput } from './results.ts';

const SIZE_TIMEOUT_MS = 30_000;

interface OtherHomeDevice {
  kind: 'ios' | 'android';
  id: string;
  name: string | null;
  present: boolean | null;
  command: string | null;
}

export interface OtherHome {
  path: string;
  state: 'present' | 'gone' | 'unverified';
  createdAt: string;
  lastSeenAt: string;
  bytes: number | null;
  privateBytes: number | null;
  workspaces: number;
  devices: OtherHomeDevice[];
  teardown: string[];
  forgettable: boolean;
}

export interface OtherHomesReport {
  homes: OtherHome[];
  notice: string | null;
}

export interface OtherHomesDependencies {
  homesRoot?: string;
}

interface DeviceListing {
  sims: IosSimRecord[] | null;
  avds: string[] | null;
}

function workspaceRoots(home: string): (string | null)[] {
  const dir = join(home, 'workspaces');
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const metadata = readJsonObject(join(dir, name, 'workspace.json'));
    if (!metadata) return [];
    return [typeof metadata.projectRoot === 'string' ? metadata.projectRoot : null];
  });
}

function homeDevices(
  ids: { ios: Iterable<string>; android: Iterable<string> },
  listing: DeviceListing,
  deletable: boolean,
) {
  const devices: OtherHomeDevice[] = [];
  for (const id of new Set(ids.ios)) {
    const sim = listing.sims?.find((entry) => entry.udid === id);
    const present = listing.sims === null ? null : sim !== undefined;
    devices.push({
      kind: 'ios',
      id,
      name: sim?.name ?? null,
      present,
      command: deletable && present ? unverifiedDeviceCommand({ kind: 'ios', id, name: sim?.name ?? id }) : null,
    });
  }
  for (const id of new Set(ids.android)) {
    const present = listing.avds === null ? null : listing.avds.includes(id);
    devices.push({
      kind: 'android',
      id,
      name: null,
      present,
      command: deletable && present ? unverifiedDeviceCommand({ kind: 'android', id, name: id }) : null,
    });
  }
  return devices;
}

async function removalFolder(root: string, operation?: StimContext): Promise<string> {
  const options = { env: operation?.env, signal: operation?.signal, declareFor: operation };
  const top = await repoRootAsync(root, options);
  if (!top) return root;
  const source = await resolveSourceCheckoutAsync(top, options);
  if ('refusal' in source || nativeCanonicalPath(source.path) === nativeCanonicalPath(top)) return root;
  return top;
}

async function teardownCommands(
  home: string,
  roots: readonly (string | null)[],
  operation?: StimContext,
): Promise<string[]> {
  const env = `STIM_HOME=${quotedPath(home)}`;
  const live = [...new Set(roots)].filter((root): root is string => root !== null && existsSync(root));
  const folders = new Set<string>();
  for (const root of live) folders.add(await removalFolder(root, operation));
  return [
    ...[...folders].map((folder) => `cd ${quotedPath(folder)} && ${env} stim worktree remove`),
    `${env} stim gc`,
    `rm -rf ${quotedPath(home)}`,
  ];
}

async function describeHome(
  entry: StimHomeEntry,
  listing: DeviceListing,
  mountedVolumes: string[],
  operation?: StimContext,
): Promise<OtherHome> {
  const base = { path: entry.path, createdAt: entry.createdAt, lastSeenAt: entry.lastSeenAt };
  if (isAbsentPath(entry.path)) {
    const gone = isOnMountedVolume(entry.path, mountedVolumes);
    const devices = homeDevices(entry.devices, listing, gone);
    return {
      ...base,
      state: gone ? 'gone' : 'unverified',
      bytes: null,
      privateBytes: null,
      workspaces: 0,
      devices,
      teardown: [],
      forgettable: gone && devices.every((device) => device.present === false),
    };
  }
  const ledger = readCreatedDevices(entry.path);
  const roots = workspaceRoots(entry.path);
  const size = await measureTree(entry.path, { timeoutMs: SIZE_TIMEOUT_MS, operation });
  return {
    ...base,
    state: 'present',
    bytes: size?.bytes ?? null,
    privateBytes: size?.privateBytes ?? null,
    workspaces: roots.length,
    devices: homeDevices(
      { ios: [...ledger.ios, ...entry.devices.ios], android: [...ledger.android, ...entry.devices.android] },
      listing,
      false,
    ),
    teardown: await teardownCommands(entry.path, roots, operation),
    forgettable: false,
  };
}

export async function collectOtherHomes(
  home: string,
  listing: DeviceListing,
  mountedVolumes: string[],
  deps: OtherHomesDependencies = {},
  operation?: StimContext,
): Promise<OtherHomesReport> {
  const list = readStimHomes(deps.homesRoot ?? stimHomesRoot());
  if (!list.safe) return { homes: [], notice: list.notice };
  const own = canonicalPath(home);
  const entries = [...list.homes.values()].filter((entry) => entry.path !== own && isTrackedStimHome(entry.path));
  const homes = await mapLimited(entries, sizeConcurrency(operation), (entry) =>
    describeHome(entry, listing, mountedVolumes, operation),
  );
  return { homes: homes.toSorted((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt)), notice: null };
}

function ago(at: string, now: number): string {
  return `${formatLongDuration(Math.max(0, now - Date.parse(at)))} ago`;
}

function deviceLine(device: OtherHomeDevice, home: OtherHome): string[] {
  const label =
    device.kind === 'ios' ? `ios ${device.name ?? 'simulator'} (${shortUdid(device.id)})` : `android ${device.id}`;
  if (device.present === false) return [`    ${label}: not on this machine`];
  if (device.present === null) return [`    ${label}: listing unavailable`];
  if (home.state === 'present') return [`    ${label}: on this machine, owned by that home`];
  if (home.state === 'unverified')
    return [`    ${label}: on this machine; its home is on a volume that is not mounted`];
  return [`    orphaned from ${home.path}: ${label} is still on this machine`, `      ${device.command}`];
}

export function otherHomeLines(homes: readonly OtherHome[] = [], now: number = Date.now()): string[] {
  if (!homes.length) return [];
  const lines = [
    `Other Stim homes (${homes.length}) - report only; this home never changes them, and their devices are not its own:`,
  ];
  for (const home of homes) {
    const size =
      home.privateBytes !== null
        ? `, ${formatBytes(home.privateBytes)} private`
        : home.bytes !== null
          ? `, ${formatBytes(home.bytes)}`
          : '';
    const state =
      home.state === 'present'
        ? `${plural(home.workspaces, 'workspace')}${size}`
        : home.state === 'gone'
          ? 'gone'
          : 'directory missing on a volume that is not mounted; kept';
    lines.push(`  ${home.path} (${state}, last seen ${ago(home.lastSeenAt, now)})`);
    for (const device of home.devices) lines.push(...deviceLine(device, home));
    if (home.forgettable)
      lines.push('    nothing of it is left on this machine; --delete forgets the LIST ENTRY only.');
    for (const command of home.teardown) lines.push(`    ${command}`);
  }
  return lines;
}

export function forgetGoneHomes(
  homes: readonly OtherHome[],
  mountedVolumes: string[],
  deps: OtherHomesDependencies = {},
  output: GcOutput = GC_OUTPUT,
): number {
  const candidates = homes.filter((home) => home.forgettable);
  if (!candidates.length) return 0;
  const known = new Map(candidates.map((home) => [home.path, home]));
  try {
    const removed = new Set(
      forgetStimHomes(
        [...known.keys()],
        (entry) =>
          isAbsentPath(entry.path) &&
          isOnMountedVolume(entry.path, mountedVolumes) &&
          JSON.stringify(entry.devices) === JSON.stringify(devicesOf(known.get(entry.path))),
        deps.homesRoot ?? stimHomesRoot(),
      ),
    );
    for (const path of known.keys()) {
      if (removed.has(path)) {
        output.log(chalk.green(`Forgot the Stim home ${path} (it is gone and nothing of it is left)`));
        output.record('homeEntry', 'done', path, { id: path });
      } else {
        output.log(chalk.dim(`Kept the Stim home entry ${path}: it changed since the report.`));
        output.record('homeEntry', 'kept', path, { id: path, detail: 'it changed since the report' });
      }
    }
    return 0;
  } catch (error) {
    output.log(chalk.red(`Could not forget the gone Stim homes: ${describeError(error)}`));
    output.record('homeEntry', 'failed', 'gone Stim homes', { detail: describeError(error) });
    return candidates.length;
  }
}

function devicesOf(home: OtherHome | undefined): StimHomeEntry['devices'] {
  return {
    ios: home?.devices.filter((device) => device.kind === 'ios').map((device) => device.id) ?? [],
    android: home?.devices.filter((device) => device.kind === 'android').map((device) => device.id) ?? [],
  };
}
