import {
  type AndroidEmulatorApp,
  configuredAndroidEmulatorApp,
  openEmulatorInStimDesktop,
} from './android-emulator-viewer.ts';
import { forgetCreatedDevice, recordCreatedDevice } from './created-devices.ts';
import { isStimOwnedAvd } from './device-ownership.ts';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { homedir, tmpdir } from 'os';
import { dirname, isAbsolute, join, resolve } from 'path';
import { type Executor, getExecutor } from '../exec.ts';
import { pidExists, signalProcessTree } from '../metro.ts';
import { captureProcessIdentity, inspectProcessIdentity, type ProcessRecord } from '../process-identity.ts';
import { androidDataPartitionSizeBytes } from '../workspace/settings.ts';
import { settingDefinition } from '@stim-cli/core/state';

export interface SystemImage {
  api: number;
  tag: string;
  arch: string;
  pkg: string;
}

const ANDROID_ABIS = new Set(['armeabi-v7a', 'arm64-v8a', 'x86', 'x86_64']);
export const DEFAULT_AVD_DEVICE_PROFILE: string = String(settingDefinition('android.deviceProfile')?.default);

interface AdbEmulatorEntry {
  serial: string;
  consolePort: number;
}

interface AdbPhysicalEntry {
  serial: string;
}

interface AdbUnhealthyEntry {
  serial: string;
  kind: 'emulator' | 'physical';
  consolePort?: number;
  status: string;
}

export interface AdbDevices {
  emulators: AdbEmulatorEntry[];
  physical: AdbPhysicalEntry[];
  unhealthy: AdbUnhealthyEntry[];
}

export interface BootResult {
  ok: boolean;
  exited?: true;
  diagnostic?: {
    devices: string;
    sysBoot: string;
    devBoot: string;
    bootAnim: string;
    packageManager: string;
  };
}

export interface ResolvedAvdSerial {
  missing?: true;
  notOwned?: true;
  serial?: string;
  notRunning?: true;
}

export function androidHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.ANDROID_HOME || env.ANDROID_SDK_ROOT;
  if (configured) return configured;
  if (process.platform === 'win32') {
    return join(env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Android', 'Sdk');
  }
  return join(homedir(), 'Library', 'Android', 'sdk');
}

const SDK_TOOL_LOCATIONS = {
  emulator: ['emulator', 'emulator'],
  adb: ['platform-tools', 'adb'],
  avdmanager: ['cmdline-tools', 'latest', 'bin', 'avdmanager'],
} as const;

// The Windows SDK ships avdmanager as a batch wrapper around its jar; adb and the emulator are
// plain executables.
const WINDOWS_SDK_TOOL_EXTENSIONS: Readonly<Record<AndroidTool, string>> = {
  emulator: '.exe',
  adb: '.exe',
  avdmanager: '.bat',
};

type AndroidTool = keyof typeof SDK_TOOL_LOCATIONS;

export function androidToolPath(tool: AndroidTool, platform: NodeJS.Platform = process.platform): string {
  const location = SDK_TOOL_LOCATIONS[tool];
  const bare = location.at(-1) as string;
  const name = platform === 'win32' ? `${bare}${WINDOWS_SDK_TOOL_EXTENSIONS[tool]}` : bare;
  const abs = join(androidHome(), ...location.slice(0, -1), name);
  return existsSync(abs) ? abs : bare;
}

export interface BuildToolsEntry {
  path: string;
  tool: string;
  version: string;
  major: number;
}

// The Android SDK ships apksigner as a Windows batch wrapper around its jar;
// every other build-tools entry is a plain .exe.
const WINDOWS_BUILD_TOOL_EXTENSIONS: Readonly<Record<string, string>> = { apksigner: '.bat' };

export function androidBuildToolName(tool: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return tool;
  return `${tool}${WINDOWS_BUILD_TOOL_EXTENSIONS[tool] ?? '.exe'}`;
}

export function newestBuildTools(names: unknown): string | null {
  return (
    [...(Array.isArray(names) ? names : [])]
      .filter((n) => /^\d+(\.\d+)*(-\w+)?$/.test(String(n)))
      .toSorted((a, b) => {
        const pa = String(a).split(/[.-]/).map(Number);
        const pb = String(b).split(/[.-]/).map(Number);
        for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
          const d = (pb[i] || 0) - (pa[i] || 0);
          if (d) return d;
        }
        return 0;
      })[0] ?? null
  );
}

export function buildToolsMajor(version: unknown): number {
  const major = Number(String(version ?? '').split(/[.-]/)[0]);
  return Number.isFinite(major) ? major : 0;
}

export function findBuildTool(
  tools: readonly string[],
  {
    home = androidHome(),
    readDir = readdirSync,
    exists = existsSync,
    platform = process.platform,
  }: {
    home?: string;
    readDir?: (path: string) => string[];
    exists?: (path: string) => boolean;
    platform?: NodeJS.Platform;
  } = {},
): BuildToolsEntry | null {
  const root = join(home, 'build-tools');
  let versions: string[] = [];
  try {
    versions = readDir(root);
  } catch {
    return null;
  }
  while (versions.length) {
    const version = newestBuildTools(versions);
    if (!version) return null;
    for (const tool of tools) {
      const path = join(root, version, androidBuildToolName(tool, platform));
      if (exists(path)) return { path, tool, version, major: buildToolsMajor(version) };
    }
    versions = versions.filter((v) => v !== version);
  }
  return null;
}

function androidTool(tool: AndroidTool): string {
  const resolved = androidToolPath(tool);
  return resolved === tool ? tool : `"${resolved}"`;
}

export function listInstalledSystemImages(): SystemImage[] {
  const root = join(androidHome(), 'system-images');
  const images: SystemImage[] = [];
  if (!existsSync(root)) return images;
  for (const apiDir of safeList(root)) {
    const m = apiDir.match(/^android-(\d+)$/);
    if (!m) continue;
    const apiPath = join(root, apiDir);
    for (const tag of safeList(apiPath)) {
      for (const arch of safeList(join(apiPath, tag))) {
        images.push({ api: Number(m[1]), tag, arch, pkg: `system-images;${apiDir};${tag};${arch}` });
      }
    }
  }
  return images;
}

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function pageSizeRank(image: SystemImage): number {
  return /(^|_)ps16k$/.test(String(image?.tag || '')) ? 1 : 0;
}

export function hostSystemImageArch(arch: string = process.arch): string {
  return arch === 'arm64' ? 'arm64-v8a' : 'x86_64';
}

export function pickDefaultSystemImage(
  images: SystemImage[],
  { systemImage, hostArch }: { systemImage?: string; hostArch?: string } = {},
): SystemImage | null {
  if (systemImage) return images.find((i) => i.pkg === systemImage) || null;
  const wanted = hostArch ?? hostSystemImageArch();
  const matching = images.filter((i) => i.arch === wanted);
  if (matching.length === 0) return null;
  return (
    matching.toSorted(
      (a, b) =>
        pageSizeRank(a) - pageSizeRank(b) ||
        b.api - a.api ||
        (b.tag === 'google_apis' ? 1 : 0) - (a.tag === 'google_apis' ? 1 : 0),
    )[0] ?? null
  );
}

// Android Emulator 35.6 quits these profiles at startup with "Device %s requires foldable feature, but
// the system image does not support. Quit." unless the image's advancedFeatures.ini turns on
// SupportPixelFold. Other hinged profiles, e.g. "7.6in Foldable", boot on images without it.
const FOLD_FEATURE_PROFILES: ReadonlySet<string> = new Set(['pixel_fold', 'resizable']);

export function profileNeedsFoldFeature(profile: string | null | undefined): boolean {
  return typeof profile === 'string' && FOLD_FEATURE_PROFILES.has(profile);
}

export function systemImageSupportsFold(pkg: string, home: string = androidHome()): boolean {
  try {
    const ini = readFileSync(join(home, ...pkg.split(';'), 'advancedFeatures.ini'), 'utf8');
    return /^\s*SupportPixelFold\s*=\s*on\s*$/im.test(ini);
  } catch {
    return false;
  }
}

export async function createOwnedAvd(
  label: string,
  {
    systemImage,
    deviceProfile = DEFAULT_AVD_DEVICE_PROFILE,
    spawn = (...args) => getExecutor().spawn(...args),
  }: { systemImage?: string; deviceProfile?: string; spawn?: Executor['spawn'] } = {},
): Promise<{ avdName: string; systemImage: string; deviceProfile: string }> {
  const pick = pickDefaultSystemImage(listInstalledSystemImages(), { systemImage });
  if (!pick) {
    const arch = hostSystemImageArch();
    throw new Error(
      `No ${arch} Android system image is installed. Install one, e.g.: sdkmanager "system-images;android-36;google_apis;${arch}"`,
    );
  }
  const avdName = ownedAvdName(label);
  recordCreatedDevice('android', avdName);
  const tool = androidToolPath('avdmanager');
  const args = ['create', 'avd', '-n', avdName, '-k', pick.pkg, '--device', deviceProfile];
  const child = spawn(tool, args, { detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stdout?.on('data', () => {});
  child.stderr?.on('data', (chunk) => {
    stderr = (stderr + String(chunk)).slice(-64 * 1024 * 1024);
  });
  const completed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((finish, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => finish({ code, signal }));
  });
  child.stdin?.on('error', () => {});
  child.stdin?.end('no\n');
  const result = await completed;
  if (result.code !== 0) {
    throw new Error(`Command failed: ${tool} ${args.join(' ')} (${result.signal ?? result.code})\n${stderr.trim()}`);
  }
  return { avdName, systemImage: pick.pkg, deviceProfile };
}

// avdmanager joins image.sysdir.1 with File.separator, so an AVD created on
// Windows stores backslashes.
export function parseAvdSystemImage(configIni: string): string | null {
  const dir = avdIniValue(configIni, 'image.sysdir.1')?.replace(/[\\/]+$/, '');
  if (!dir) return null;
  return dir.split(/[\\/]/).join(';');
}

function parseAvdDeviceProfile(configIni: string): string | null {
  return avdIniValue(configIni, 'hw.device.name') || null;
}

function avdIniValue(configIni: string, key: string): string | null {
  for (const line of String(configIni).split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator < 0) continue;
    if (line.slice(0, separator).trim() !== key) continue;
    return line.slice(separator + 1).trim();
  }
  return null;
}

export function ownedAvdSystemImage(
  avdName: string,
  {
    avdDirectory = ownedAvdDirectory,
    readFile = (path: string) => readFileSync(path, 'utf8'),
  }: { avdDirectory?: typeof ownedAvdDirectory; readFile?: (path: string) => string } = {},
): string | null {
  const directory = avdDirectory(avdName);
  if (!directory) return null;
  try {
    return parseAvdSystemImage(readFile(join(directory, 'config.ini')));
  } catch {
    return null;
  }
}

export function ownedAvdDeviceProfile(avdName: string): string | null {
  const configIni = avdConfigIni(avdName);
  return configIni === null ? null : parseAvdDeviceProfile(configIni);
}

const AVDMANAGER_LIST_TIMEOUT_MS = 60_000;

export function listAvdDeviceProfiles(): string[] {
  return parseAvdList(
    getExecutor().runFile(androidToolPath('avdmanager'), ['list', 'device', '-c'], {
      timeoutMs: AVDMANAGER_LIST_TIMEOUT_MS,
    }),
  );
}

function sanitizeAvdLabel(label: string): string {
  return String(label)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function avdConfigIni(avdName: string, directory: string | null = ownedAvdDirectory(avdName)): string | null {
  if (!directory) return null;
  try {
    return readFileSync(join(directory, 'config.ini'), 'utf8');
  } catch {
    return null;
  }
}

export function ownedAvdName(label: string): string {
  const clean = sanitizeAvdLabel(label);
  return `stim-${clean.startsWith('stim-') ? clean.slice('stim-'.length) : clean}`;
}

const AVDMANAGER_DELETE_TIMEOUT_MS = 120_000;

export function deleteAvd(avdName: string): void {
  if (!isStimOwnedAvd(avdName)) {
    throw new Error(`Refusing to delete AVD "${avdName}": not a Stim-owned AVD; Stim has no record of creating it.`);
  }
  getExecutor().run(`${androidTool('avdmanager')} delete avd -n "${avdName}"`, {
    timeoutMs: AVDMANAGER_DELETE_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
  forgetCreatedDevice('android', avdName);
}

export function parseAvdList(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('INFO') && !l.startsWith('WARNING'));
}

export function parseAdbDevices(text: string): AdbDevices {
  const lines = text.split('\n').slice(1);
  const emulators: AdbEmulatorEntry[] = [];
  const physical: AdbPhysicalEntry[] = [];
  const unhealthy: AdbUnhealthyEntry[] = []; // serials adb sees but can't talk to (unauthorized/offline)
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(\S+)\s+(.+)$/);
    if (!match) continue;
    const serial = match[1]!;
    const status = match[2]!.trim();
    const m = serial.match(/^emulator-(\d+)$/);
    if (m) {
      const consolePort = parseInt(m[1]!, 10);
      if (status === 'device') {
        emulators.push({ serial, consolePort });
      } else {
        unhealthy.push({ serial, kind: 'emulator', consolePort, status });
      }
    } else {
      if (status === 'device') {
        physical.push({ serial });
      } else {
        unhealthy.push({ serial, kind: 'physical', status });
      }
    }
  }
  return { emulators, physical, unhealthy };
}

export function listAvds({ timeoutMs }: { timeoutMs?: number } = {}): string[] {
  return parseAvdList(getExecutor().run(`${androidTool('emulator')} -list-avds`, { timeoutMs }));
}

/**
 * Working directory for the adb client and the emulator Stim starts. Both leave processes behind
 * that inherit it: the adb server is spawned by whichever client finds none running, and the
 * emulator launcher forks qemu and a crashpad handler that outlives a crash on exit. On Windows a
 * process holds its working directory open, and Windows refuses to delete a directory with an open
 * handle, so one started from a worktree breaks `worktree remove`.
 * https://github.com/appandflow/stim/issues/914
 */
export function androidToolCwd(platform: NodeJS.Platform = process.platform): string | undefined {
  return platform === 'win32' ? homedir() : undefined;
}

export function listAdbDevices({
  timeoutMs,
  platform = process.platform,
}: { timeoutMs?: number; platform?: NodeJS.Platform } = {}): AdbDevices {
  return parseAdbDevices(
    getExecutor().run(`${androidTool('adb')} devices`, { timeoutMs, cwd: androidToolCwd(platform) }),
  );
}

const ADB_PROP_TIMEOUT_MS = 5000;
const EMULATOR_HARDWARE = new Set(['ranchu', 'goldfish', 'vbox86', 'vbox86p']);

function adbProp(serial: string, name: string): string | null {
  try {
    const out = getExecutor().runFile(androidToolPath('adb'), ['-s', serial, 'shell', 'getprop', name], {
      timeoutMs: ADB_PROP_TIMEOUT_MS,
    });
    return String(out ?? '').trim() || null;
  } catch {
    return null;
  }
}

export function physicalDeviceModel(serial: string): string | null {
  return adbProp(serial, 'ro.product.model');
}

export function androidDeviceAbi(serial: string): string | null {
  const abi = adbProp(serial, 'ro.product.cpu.abi');
  return abi && ANDROID_ABIS.has(abi) ? abi : null;
}

export function androidSystemImageAbi(systemImage: string | null | undefined): string | null {
  const abi =
    String(systemImage ?? '')
      .split(';')
      .at(-1) ?? '';
  return ANDROID_ABIS.has(abi) ? abi : null;
}

function looksLikeEmulator({
  kernelQemu,
  hardware,
}: {
  kernelQemu?: string | null;
  hardware?: string | null;
}): boolean {
  if (String(kernelQemu ?? '').trim() === '1') return true;
  return EMULATOR_HARDWARE.has(
    String(hardware ?? '')
      .trim()
      .toLowerCase(),
  );
}

export function probeEmulatorSerial(serial: string): boolean {
  return looksLikeEmulator({
    kernelQemu: adbProp(serial, 'ro.kernel.qemu'),
    hardware: adbProp(serial, 'ro.hardware'),
  });
}

export interface ResolvedPhysicalDevice {
  serial?: string;
  error?: string;
  remedy?: string;
}

function unreachableDeviceRefusal(entry: AdbUnhealthyEntry): ResolvedPhysicalDevice {
  return {
    error: `${entry.serial} is connected but ${entry.status}, so adb cannot talk to it.`,
    remedy:
      entry.status === 'unauthorized'
        ? 'Unlock the device, accept the USB debugging prompt, then retry.'
        : 'Reconnect the device or run `adb reconnect`, then retry.',
  };
}

function emulatorRefusal(serial: string): ResolvedPhysicalDevice {
  return {
    error: `${serial} is an emulator, not a physical device.`,
    remedy: "Run `stim android` without --device to use this workspace's owned emulator.",
  };
}

export function memoizeEmulatorProbe(
  probe: (serial: string) => boolean = probeEmulatorSerial,
): (serial: string) => boolean {
  const seen = new Map<string, boolean>();
  return (serial: string) => {
    const cached = seen.get(serial);
    if (cached !== undefined) return cached;
    const probed = probe(serial);
    seen.set(serial, probed);
    return probed;
  };
}

export function androidPoolCandidates(
  adb: AdbDevices,
  isEmulator: (serial: string) => boolean = probeEmulatorSerial,
): AdbPhysicalEntry[] {
  return (adb?.physical ?? []).filter((entry) => !isEmulator(entry.serial));
}

export function androidPoolNoCandidatesRefusal(
  adb: AdbDevices,
  isEmulator: (serial: string) => boolean = probeEmulatorSerial,
): ResolvedPhysicalDevice {
  const physical = adb?.physical ?? [];
  if (physical.length > 0 && physical.every((entry) => isEmulator(entry.serial))) {
    const reasons = physical.map((entry) => emulatorRefusal(entry.serial));
    return {
      error: reasons.map((reason) => reason.error!).join(' '),
      remedy: [...new Set(reasons.map((reason) => reason.remedy!))].join(' '),
    };
  }
  return resolvePhysicalDevice(null, adb, isEmulator);
}

export function resolvePhysicalDevice(
  requested: string | null,
  adb: AdbDevices,
  isEmulator: (serial: string) => boolean = probeEmulatorSerial,
): ResolvedPhysicalDevice {
  const physical = adb?.physical ?? [];
  const unhealthy = adb?.unhealthy ?? [];
  if (requested) {
    if (physical.some((p) => p.serial === requested)) {
      return isEmulator(requested) ? emulatorRefusal(requested) : { serial: requested };
    }
    if (/^emulator-\d+$/.test(requested)) return emulatorRefusal(requested);
    const unreachable = unhealthy.find((u) => u.serial === requested);
    if (unreachable) return unreachableDeviceRefusal(unreachable);
    const connected = physical.map((p) => p.serial);
    return {
      error: connected.length
        ? `${requested} is not connected. adb reports these physical devices: ${connected.join(', ')}.`
        : `${requested} is not connected, and adb reports no physical device at all.`,
      remedy: 'Check the cable and `adb devices`, then retry with a serial adb lists.',
    };
  }
  if (physical.length === 1) {
    const only = physical[0]!.serial;
    return isEmulator(only) ? emulatorRefusal(only) : { serial: only };
  }
  if (physical.length > 1) {
    return {
      error: `Several physical devices are connected: ${physical.map((p) => p.serial).join(', ')}.`,
      remedy: 'Name the one to build for with `stim android --device <serial>`.',
    };
  }
  const unreachable = unhealthy.find((u) => u.kind === 'physical');
  if (unreachable) return unreachableDeviceRefusal(unreachable);
  return {
    error: 'No physical Android device is connected.',
    remedy: 'Plug the device in, accept the USB debugging prompt, then check `adb devices`.',
  };
}

export function nextConsolePort(claimedPorts: number[]): number {
  if (claimedPorts.length === 0) return 5554;
  const max = Math.max(...claimedPorts);
  return max + 2;
}

export function headlessEmulatorArgs(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  app: AndroidEmulatorApp = 'emulator',
): string[] {
  const args: string[] = [];
  if (platform === 'darwin' && app === 'stim-desktop') args.push('-no-window', '-gpu', 'host');
  if (platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY) {
    args.push(
      '-no-window',
      '-noaudio',
      '-no-boot-anim',
      '-gpu',
      'swiftshader_indirect',
      '-no-snapshot-save',
      '-no-snapshot-load',
    );
  }
  return args;
}

export function parseAvdRootIni(contents: string): { path: string | null; relativePath: string | null } {
  let path: string | null = null;
  let relativePath: string | null = null;
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const separator = line.indexOf('=');
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!value) continue;
    if (key === 'path') path = value;
    if (key === 'path.rel') relativePath = value;
  }
  return { path, relativePath };
}

function avdIniPaths(root: string, ini: string): string[] {
  const parsed = parseAvdRootIni(ini);
  return [
    parsed.relativePath && !isAbsolute(parsed.relativePath) ? resolve(dirname(root), parsed.relativePath) : null,
    parsed.path && isAbsolute(parsed.path) ? parsed.path : null,
  ].filter((candidate): candidate is string => candidate !== null);
}

export function avdStorageRoots(): string[] {
  const env = process.env;
  return [
    ...new Set(
      [
        env.ANDROID_AVD_HOME,
        env.ANDROID_EMULATOR_HOME ? join(env.ANDROID_EMULATOR_HOME, 'avd') : null,
        env.ANDROID_USER_HOME ? join(env.ANDROID_USER_HOME, 'avd') : null,
        env.ANDROID_SDK_HOME ? join(env.ANDROID_SDK_HOME, '.android', 'avd') : null,
        env.ANDROID_SDK_HOME ? join(env.ANDROID_SDK_HOME, 'avd') : null,
        join(homedir(), '.android', 'avd'),
      ].filter((value): value is string => Boolean(value)),
    ),
  ];
}

export interface OrphanedAvdDirectory {
  name: string;
  directory: string;
  dev: number;
  ino: number;
}

export function avdPathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export function listOrphanedAvdDirectories(avdName?: string): OrphanedAvdDirectory[] {
  const roots = avdStorageRoots();
  const stores = roots.filter(avdPathExists).map((root) => ({
    root,
    canonicalRoot: realpathSync(root),
    names: readdirSync(root),
  }));
  const registered = new Set<string>();
  for (const { root, canonicalRoot, names } of stores) {
    for (const name of names.filter((entry) => entry.endsWith('.ini'))) {
      const path = join(root, name);
      const ini = readFileSync(path, 'utf8');
      const targets = new Set([...avdIniPaths(root, ini), ...avdIniPaths(canonicalRoot, ini)]);
      if (!targets.size) throw new Error(`Cannot verify AVD registration at ${path}; its data was kept.`);
      for (const target of targets) {
        try {
          registered.add(realpathSync(target));
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
        }
      }
    }
  }
  const orphaned: OrphanedAvdDirectory[] = [];
  for (const { canonicalRoot, names: entries } of stores) {
    const names = avdName ? [`${avdName}.avd`] : entries;
    for (const entry of names) {
      if (!/^stim-[A-Za-z0-9._-]+\.avd$/.test(entry)) continue;
      const name = entry.slice(0, -4);
      if (roots.some((candidate) => avdPathExists(join(candidate, `${name}.ini`)))) continue;
      const directory = join(canonicalRoot, entry);
      if (registered.has(directory) || !avdPathExists(directory)) continue;
      const stat = lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(directory) !== directory) {
        throw new Error(`Cannot verify AVD data at ${directory}; it was kept.`);
      }
      if (!orphaned.some((candidate) => candidate.directory === directory)) {
        orphaned.push({ name, directory, dev: stat.dev, ino: stat.ino });
      }
    }
  }
  return orphaned;
}

export function ownedAvdDirectory(
  avdName: string,
  {
    env = process.env,
    home = homedir(),
    readFile = (path: string) => readFileSync(path, 'utf8'),
    realpath = realpathSync,
    isDirectory = (path: string) => statSync(path).isDirectory(),
  }: {
    env?: NodeJS.ProcessEnv;
    home?: string;
    readFile?: (path: string) => string;
    realpath?: (path: string) => string;
    isDirectory?: (path: string) => boolean;
  } = {},
): string | null {
  if (!/^stim-[A-Za-z0-9._-]+$/.test(avdName)) return null;
  const roots = [
    env.ANDROID_AVD_HOME,
    env.ANDROID_SDK_HOME ? join(env.ANDROID_SDK_HOME, 'avd') : null,
    join(home, '.android', 'avd'),
  ];
  for (const root of new Set(roots.filter((value): value is string => Boolean(value)))) {
    let ini: string;
    try {
      ini = readFile(join(root, `${avdName}.ini`));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') continue;
      return null;
    }
    for (const candidate of avdIniPaths(root, ini)) {
      try {
        const canonical = realpath(candidate);
        if (isDirectory(canonical)) return canonical;
      } catch {}
    }
    return null;
  }
  return null;
}

// The Android Emulator writes these on boot and recreates them from the
// initial userdata.img when absent; an AVD fresh from avdmanager has none.
const AVD_USER_DATA = [
  'userdata-qemu.img',
  'userdata-qemu.img.qcow2',
  'encryptionkey.img',
  'encryptionkey.img.qcow2',
  'cache.img',
  'cache.img.qcow2',
  'snapshots',
];

export function wipeAvdUserData(directory: string): void {
  for (const name of AVD_USER_DATA) rmSync(join(directory, name), { recursive: true, force: true });
}

export function withAvdDataPartitionSize(contents: string, sizeBytes: number): string {
  return withAvdConfigOverrides(contents, { 'disk.dataPartition.size': String(sizeBytes) });
}

export function withAvdConfigOverrides(contents: string, overrides: Readonly<Record<string, string>>): string {
  const newline = contents.includes('\r\n') ? '\r\n' : '\n';
  const trailingNewline = /\r?\n$/.test(contents);
  const lines = contents.split(/\r?\n/);
  if (trailingNewline) lines.pop();
  const updated: string[] = [];
  const remaining = new Map(Object.entries(overrides));
  for (const line of lines) {
    const separator = line.indexOf('=');
    const key = separator >= 0 ? line.slice(0, separator).trim() : '';
    if (!remaining.has(key)) {
      if (!Object.hasOwn(overrides, key)) updated.push(line);
      continue;
    }
    updated.push(`${key}=${remaining.get(key)}`);
    remaining.delete(key);
  }
  for (const [key, value] of remaining) updated.push(`${key}=${value}`);
  return updated.join(newline) + (trailingNewline ? newline : '');
}

let avdConfigWriteSequence = 0;

export function configureNewOwnedAvd(
  avdName: string,
  {
    dataPartitionSizeGb,
    avdConfig = {},
  }: { dataPartitionSizeGb: number; avdConfig?: Readonly<Record<string, string>> },
  {
    avdDirectory = ownedAvdDirectory,
    readFile = (path: string) => readFileSync(path, 'utf8'),
    writeFile = (path: string, contents: string) => writeFileSync(path, contents, { encoding: 'utf8', flag: 'wx' }),
    rename = renameSync,
    remove = (path: string) => rmSync(path, { force: true }),
  }: {
    avdDirectory?: typeof ownedAvdDirectory;
    readFile?: (path: string) => string;
    writeFile?: (path: string, contents: string) => void;
    rename?: (from: string, to: string) => void;
    remove?: (path: string) => void;
  } = {},
): string {
  const sizeBytes = androidDataPartitionSizeBytes(dataPartitionSizeGb);
  const directory = avdDirectory(avdName);
  if (!directory) throw new Error(`Could not resolve the content directory for newly created AVD ${avdName}.`);
  const configPath = join(directory, 'config.ini');
  const original = readFile(configPath);
  const expected = { ...avdConfig, 'disk.dataPartition.size': String(sizeBytes) };
  const updated = withAvdConfigOverrides(original, expected);
  const tempPath = join(directory, `.config.ini.stim-${process.pid}-${++avdConfigWriteSequence}.tmp`);
  try {
    writeFile(tempPath, updated);
    rename(tempPath, configPath);
  } catch (error) {
    try {
      remove(tempPath);
    } catch {}
    throw error;
  }
  const verified = readFile(configPath);
  for (const [key, value] of Object.entries(expected)) {
    if (!verified.split(/\r?\n/).includes(`${key}=${value}`)) {
      throw new Error(`Could not verify ${key} in ${configPath}.`);
    }
  }
  return configPath;
}

/**
 * Values every AVD Stim creates gets unless `android.avdConfig` or `android.avdConfigFile` sets the key. The
 * emulator drops gRPC `sendKey` events on an AVD without a hardware keyboard.
 */
export const OWNED_AVD_CONFIG_DEFAULTS: Readonly<Record<string, string>> = Object.freeze({ 'hw.keyboard': 'yes' });

export function avdPoolConfiguration(
  dataPartitionSizeGb: number,
  avdConfig: Record<string, string>,
  deviceProfile: string = DEFAULT_AVD_DEVICE_PROFILE,
): string {
  return JSON.stringify(
    Object.entries({
      ...avdConfig,
      'hw.device.name': deviceProfile,
      'disk.dataPartition.size': String(androidDataPartitionSizeBytes(dataPartitionSizeGb)),
    }).toSorted(([a], [b]) => a.localeCompare(b)),
  );
}

export function ownedAvdMatchesConfiguration(avdName: string, configuration: string): boolean {
  const directory = ownedAvdDirectory(avdName);
  if (!directory) return false;
  const contents = readFileSync(join(directory, 'config.ini'), 'utf8');
  const expected: unknown = JSON.parse(configuration);
  return (
    Array.isArray(expected) &&
    expected.length > 0 &&
    expected.every(
      (entry) =>
        Array.isArray(entry) &&
        entry.length === 2 &&
        entry.every((value) => typeof value === 'string') &&
        contents.split(/\r?\n/).some((line) => line.trim() === `${entry[0]}=${entry[1]}`),
    )
  );
}

export async function resetAdoptedAvd(avdName: string, serial: string, keepPackage: string): Promise<void> {
  const exec = getExecutor();
  let recoveryDeadline: number | undefined;
  let firstFailure: string | undefined;
  let unavailableTarget = false;
  const commandTimeout = (timeoutMs: number) =>
    recoveryDeadline === undefined ? timeoutMs : Math.max(1, Math.min(timeoutMs, recoveryDeadline - Date.now()));
  const assertTarget = () => {
    const resolved = resolveOwnedAvdSerial(avdName, { timeoutMs: commandTimeout(30000) });
    unavailableTarget = Boolean(resolved.notRunning);
    if (resolved.serial !== serial) throw new Error(`AVD ${avdName} is no longer running on ${serial}.`);
  };
  for (;;) {
    unavailableTarget = false;
    try {
      assertTarget();
      const output = exec.runFile('adb', ['-s', serial, 'shell', 'pm', 'list', 'packages', '-3'], {
        timeoutMs: commandTimeout(30000),
      });
      const packages = output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const match = /^package:([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+)$/.exec(line);
          if (!match) throw new Error(`Could not read installed apps on ${avdName}: ${line}`);
          return match[1]!;
        });
      for (const packageName of packages) {
        assertTarget();
        const args = packageName === keepPackage ? ['shell', 'pm', 'clear', packageName] : ['uninstall', packageName];
        const result = exec.runFile('adb', ['-s', serial, ...args], { timeoutMs: commandTimeout(120000) });
        if (result.trim() !== 'Success')
          throw new Error(`Could not clean ${packageName} on ${avdName}: ${result.trim()}`);
      }
      return;
    } catch (error) {
      const failed = error as Error & { stderr?: unknown; stdout?: unknown };
      const detail = [failed?.message || String(error), failed?.stderr, failed?.stdout]
        .filter(Boolean)
        .map(String)
        .join('\n');
      firstFailure ??= detail;
      const diagnostic = detail === firstFailure ? detail : `${firstFailure}\nRecovery failed: ${detail}`;
      const transient = /(?:^|\n)(?:adb: )?(?:error: )?(?:device offline|closed)\s*(?:$|\n)/i.test(detail);
      recoveryDeadline ??= Date.now() + 30000;
      if ((!unavailableTarget && !transient) || Date.now() >= recoveryDeadline)
        throw new Error(diagnostic, { cause: error });
      const delayMs = Math.min(1000, recoveryDeadline - Date.now());
      await new Promise((done) => setTimeout(done, delayMs));
      const ready = await waitForBoot(serial, recoveryDeadline - Date.now(), { commandTimeoutMs: 5000 });
      if (!ready.ok)
        throw new Error(`${diagnostic}\nEmulator did not recover: ${JSON.stringify(ready.diagnostic)}`, {
          cause: error,
        });
    }
  }
}

export function parseEmulatorVersion(text: unknown): number | null {
  const match = /Android emulator version (\d+)\./.exec(String(text ?? ''));
  return match ? Number(match[1]) : null;
}

function emulatorMajorVersion(): number | null {
  return parseEmulatorVersion(getExecutor().runQuiet(`${androidTool('emulator')} -version`, { timeoutMs: 10_000 }));
}

/** The first emulator whose launcher accepts `-crash-report-mode`; an older one refuses to start with it. */
const CRASH_REPORT_MODE_EMULATOR_VERSION = 37;

/**
 * Where the emulator keeps crashpad's database on Windows: `AndroidEmulator\emu-crash-<version>.db`
 * under GetTempPath, which reads TMP before TEMP.
 */
function emulatorCrashDatabases(env: NodeJS.ProcessEnv = process.env): string[] {
  const root = join(env.TMP || env.TEMP || tmpdir(), 'AndroidEmulator');
  try {
    return readdirSync(root)
      .filter((name) => /^emu-crash-.*\.db$/.test(name))
      .map((name) => join(root, name));
  } catch {
    return [];
  }
}

/**
 * An emulator that crashed (this host's crashes on exit) leaves a report in crashpad's database,
 * and the next launch blocks on a consent dialog before qemu boots: emulator.log says "Showing
 * crashdialog to get consent." and adb never sees the device. `-crash-report-mode never` (emulator
 * 37 and later) answers it: the pending report is deleted at startup and the emulator boots.
 * `-no-metrics` does not; the dialog shows all the same. An older emulator gets the database
 * removed instead, which has the same effect unless a crash handler is still writing into it.
 * https://github.com/appandflow/stim/issues/918
 */
export function suppressEmulatorCrashConsent({
  platform = process.platform,
  version = emulatorMajorVersion,
  databases = emulatorCrashDatabases,
  remove = (path: string) => rmSync(path, { recursive: true, force: true }),
}: {
  platform?: NodeJS.Platform;
  version?: () => number | null;
  databases?: () => string[];
  remove?: (path: string) => void;
} = {}): string[] {
  if (platform !== 'win32') return [];
  const major = version();
  if (major !== null && major >= CRASH_REPORT_MODE_EMULATOR_VERSION) return ['-crash-report-mode', 'never'];
  for (const database of databases()) {
    try {
      remove(database);
    } catch {}
  }
  return [];
}

export function bootAndroidEmulator(
  avdName: string,
  consolePort: number,
  { logFile, platform = process.platform }: { logFile?: string | null; platform?: NodeJS.Platform } = {},
): number | null {
  const exec = getExecutor();
  const app = configuredAndroidEmulatorApp(platform);
  const child = exec.spawn(
    androidToolPath('emulator'),
    [
      '-avd',
      avdName,
      '-port',
      String(consolePort),
      '-grpc',
      String(consolePort + 3000),
      '-grpc-use-token',
      ...headlessEmulatorArgs(process.env, platform, app),
      ...suppressEmulatorCrashConsent({ platform }),
    ],
    {
      cwd: androidToolCwd(platform),
      detached: true,
      stdio: emulatorStdio(logFile),
    },
  );
  child?.unref?.();
  const pid = child?.pid ?? null;
  if (pid !== null && platform === 'darwin' && app === 'stim-desktop') {
    openEmulatorInStimDesktop(`emulator-${consolePort}`);
  }
  return pid;
}

function emulatorStdio(logFile?: string | null): 'ignore' | (number | 'ignore')[] {
  if (!logFile) return 'ignore';
  try {
    mkdirSync(dirname(logFile), { recursive: true });
    const fd = openSync(logFile, 'w');
    return ['ignore', fd, fd];
  } catch {
    return 'ignore';
  }
}

export const MAX_EMULATOR_FAILURE_LINES = 3;

const EMULATOR_PIPE_SEVERITY = /^(?:\S+:\s+)?(FATAL|ERROR)\s*\|\s*\S/;
const EMULATOR_PANIC = /^(?:\S+:\s+)?PANIC:\s*\S/;

export function extractEmulatorFailure(text: unknown): string[] {
  if (typeof text !== 'string' || text.trim() === '') return [];
  const matched: Array<{ line: string; fatal: boolean; index: number }> = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = String(lines[i] ?? '')
      .replace(/\r/g, '')
      .trim();
    if (!line) continue;
    const pipe = EMULATOR_PIPE_SEVERITY.exec(line);
    if (pipe) {
      matched.push({ line, fatal: pipe[1] !== 'ERROR', index: i });
      continue;
    }
    if (EMULATOR_PANIC.test(line)) matched.push({ line, fatal: true, index: i });
  }
  const fatal = matched.filter((m) => m.fatal);
  const pool = fatal.length > 0 ? fatal : matched;
  const byText = new Map<string, { line: string; index: number }>();
  for (const entry of pool) byText.set(entry.line.replace(/\s+/g, ' ').toLowerCase(), entry);
  return [...byText.values()]
    .toSorted((a, b) => a.index - b.index)
    .slice(-MAX_EMULATOR_FAILURE_LINES)
    .map((entry) => entry.line);
}

export function emulatorDiskSpaceRemedy(lines: string[]): string | null {
  const text = (Array.isArray(lines) ? lines : []).join('\n');
  if (!/ENOSPC|not enough space|no space left|disk (?:is )?full/i.test(text)) return null;
  return (
    'Free disk space (owned AVDs normally live under ~/.android/avd and can use several GB), ' +
    'then run `stim android` again.'
  );
}

export function emulatorFailureRemedy(lines: string[]): string {
  return emulatorDiskSpaceRemedy(lines) ?? 'Fix what the emulator reported above, then run `stim android` again.';
}

// runQuiet returns null whenever the command fails, which is the normal state
// for most of a boot: adb answers "device offline" or "device not found" until
// the emulator has registered. Null is "not booted yet", so it reads as an
// empty string and the poll continues.
function getprop(exec: Executor, serial: string, prop: string, timeoutMs?: number): string {
  const out = exec.runQuiet(`${androidTool('adb')} -s ${serial} shell getprop ${prop}`, { timeoutMs });
  return typeof out === 'string' ? out.trim() : '';
}

// The emulator sets sys.boot_completed before the package manager service is
// registered, and `adb install` fails with "Can't find service: package" in
// that window (#897).
const PACKAGE_MANAGER_PROBE = 'shell pm path android';

function packageManagerReady(exec: Executor, serial: string, timeoutMs?: number): boolean {
  const out = exec.runQuiet(`${androidTool('adb')} -s ${serial} ${PACKAGE_MANAGER_PROBE}`, { timeoutMs });
  return typeof out === 'string' && /^package:/m.test(out);
}

export async function waitForBoot(
  serial: string,
  timeoutMs = 60000,
  {
    aborted = () => false,
    pollMs = 1000,
    commandTimeoutMs,
  }: { aborted?: () => boolean; pollMs?: number; commandTimeoutMs?: number } = {},
): Promise<BootResult> {
  const exec = getExecutor();
  const start = Date.now();
  let exited = false;
  const probeTimeout = () =>
    commandTimeoutMs === undefined
      ? undefined
      : Math.max(1, Math.min(commandTimeoutMs, timeoutMs - (Date.now() - start)));
  while (Date.now() - start < timeoutMs) {
    const booted =
      getprop(exec, serial, 'sys.boot_completed', probeTimeout()) === '1' ||
      getprop(exec, serial, 'dev.bootcomplete', probeTimeout()) === '1';
    if (booted && packageManagerReady(exec, serial, probeTimeout())) return { ok: true };
    if (aborted()) {
      exited = true;
      break;
    }
    await new Promise((r) =>
      setTimeout(
        r,
        commandTimeoutMs === undefined ? pollMs : Math.min(pollMs, Math.max(0, timeoutMs - (Date.now() - start))),
      ),
    );
  }
  const diagnosticDeadline = Date.now() + Math.min(commandTimeoutMs ?? 5000, 5000);
  const diagnosticQuery = (args: string): string => {
    const remaining = diagnosticDeadline - Date.now();
    if (remaining <= 0) return '';
    const value = exec.runQuiet(`${androidTool('adb')} ${args}`, { timeoutMs: remaining });
    return typeof value === 'string' ? value.trim() : '';
  };
  return {
    ok: false,
    ...(exited ? { exited: true as const } : {}),
    diagnostic: {
      devices: diagnosticQuery('devices'),
      sysBoot: diagnosticQuery(`-s ${serial} shell getprop sys.boot_completed`),
      devBoot: diagnosticQuery(`-s ${serial} shell getprop dev.bootcomplete`),
      bootAnim: diagnosticQuery(`-s ${serial} shell getprop init.svc.bootanim`),
      packageManager: diagnosticQuery(`-s ${serial} ${PACKAGE_MANAGER_PROBE}`),
    },
  };
}

const ANDROID_EMULATOR_SHUTDOWN_TIMEOUT_MS = 60_000;
const ANDROID_EMULATOR_SHUTDOWN_POLL_MS = 100;

export function shutdownAndroidEmulator(
  serial: string,
  timeoutMs: number = ANDROID_EMULATOR_SHUTDOWN_TIMEOUT_MS,
): void {
  const exec = getExecutor();
  const started = Date.now();
  if (
    exec.runQuiet(`${androidTool('adb')} -s ${serial} shell sync`, { timeoutMs: Math.min(5000, timeoutMs) }) === null
  ) {
    console.error(`warning: could not flush ${serial} before shutdown; shutting it down anyway`);
  }
  exec.runQuiet(`${androidTool('adb')} -s ${serial} emu kill`, {
    timeoutMs: Math.max(1, timeoutMs - (Date.now() - started)),
  });
}

export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function avdProcessLockPaths(avdDirectory: string, platform: NodeJS.Platform): string[] {
  const names = ['hardware-qemu.ini.lock', 'userdata-qemu.img.lock'];
  return names.map((name) => join(avdDirectory, name, ...(platform === 'win32' ? ['pid'] : [])));
}

function readAvdProcessId(path: string): number | null {
  try {
    const pid = Number(readFileSync(path, 'utf8').split('\0')[0]);
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      throw new Error(`Could not read the emulator PID from process lock ${path}.`);
    }
    return pid;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw error;
  }
}

function resolveAvdProcess(
  avdName: string,
  {
    platform = process.platform,
    resolveDirectory = ownedAvdDirectory,
    readProcessId = readAvdProcessId,
  }: {
    platform?: NodeJS.Platform;
    resolveDirectory?: typeof ownedAvdDirectory;
    readProcessId?: (path: string) => number | null;
  } = {},
): { directory: string; processId: number | null } {
  const directory = resolveDirectory(avdName);
  if (!directory) throw new Error(`Could not resolve the content directory for owned AVD ${avdName}.`);
  for (const lockPath of avdProcessLockPaths(directory, platform)) {
    const processId = readProcessId(lockPath);
    if (processId !== null) return { directory, processId };
  }
  return { directory, processId: null };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function parseAvdEmulatorProcesses(psOutput: string, avdName: string): number[] {
  const command = new RegExp(
    `(?:^|/)(?:qemu-system-[^\\s/]+|emulator)(?:\\.exe)?(?:\\s.*)?\\s(?:-avd\\s+|@)${escapeRegExp(avdName)}(?:\\s|$)`,
  );
  const pids: number[] = [];
  for (const line of psOutput.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match && command.test(match[2]!)) pids.push(Number(match[1]));
  }
  return pids;
}

/**
 * Live emulator processes launched for `avdName`, read from the process table, or null when the table
 * cannot be read. Windows has no `ps`, so there only the AVD's process lock is checked.
 */
function listAvdEmulatorProcesses(avdName: string, platform: NodeJS.Platform): number[] | null {
  if (platform === 'win32') return [];
  const out = getExecutor().runFileQuiet('ps', ['-axww', '-o', 'pid=,command='], { timeoutMs: 5000 });
  return out === null ? null : parseAvdEmulatorProcesses(out, avdName);
}

function scanAvdEmulatorProcesses(
  avdName: string,
  platform: NodeJS.Platform,
  listProcesses: typeof listAvdEmulatorProcesses,
): number[] {
  const pids = listProcesses(avdName, platform);
  if (pids === null) {
    throw new Error(`Could not read the process table to verify that owned AVD ${avdName} stopped.`);
  }
  return pids;
}

export function assertOwnedAvdStopped(
  avdName: string,
  {
    processAlive = pidExists,
    listProcesses = listAvdEmulatorProcesses,
    ...resolveOptions
  }: {
    platform?: NodeJS.Platform;
    resolveDirectory?: typeof ownedAvdDirectory;
    readProcessId?: (path: string) => number | null;
    processAlive?: (pid: number) => boolean;
    listProcesses?: typeof listAvdEmulatorProcesses;
  } = {},
): void {
  const { processId } = resolveAvdProcess(avdName, resolveOptions);
  const live = new Set(scanAvdEmulatorProcesses(avdName, resolveOptions.platform ?? process.platform, listProcesses));
  if (processId !== null && processAlive(processId)) live.add(processId);
  if (live.size) {
    throw new Error(`Owned AVD ${avdName} still has a live emulator process (${[...live].join(', ')}).`);
  }
}

const CRASH_HANDLER_EXIT_TIMEOUT_MS = 15_000;

/**
 * The crashpad handler qemu forks on Windows. It outlives an emulator that crashes on exit while
 * it writes the dump, so a `stop` that returns on qemu's exit leaves it running.
 * https://github.com/appandflow/stim/issues/918
 */
function emulatorCrashHandlerPids(qemuPid: number): number[] {
  const out = getExecutor().runFileQuiet(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'crashpad_handler.exe' -and $_.ParentProcessId -eq ${qemuPid} } | ForEach-Object ProcessId`,
    ],
    { timeoutMs: 10_000 },
  );
  return String(out ?? '')
    .split(/\r?\n/)
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isSafeInteger(pid) && pid > 0);
}

const EMULATOR_SIGNAL_GRACE_MS = 5000;

/**
 * Shuts down the emulator of an owned AVD and returns only once every emulator process launched for it
 * has exited. `shutdown` asks the emulator to quit through its console; it is null when the emulator is
 * not reachable over adb. Processes still running after half the timeout get SIGTERM, then SIGKILL, but
 * only a process whose command line names this AVD and whose identity, captured before shutdown, still
 * matches.
 */
export function waitForAndroidEmulatorShutdown(
  avdName: string,
  shutdown: ((timeoutMs: number) => void) | null,
  {
    timeoutMs = ANDROID_EMULATOR_SHUTDOWN_TIMEOUT_MS,
    pollMs = ANDROID_EMULATOR_SHUTDOWN_POLL_MS,
    signalGraceMs = EMULATOR_SIGNAL_GRACE_MS,
    platform = process.platform,
    resolveDirectory = ownedAvdDirectory,
    readProcessId = readAvdProcessId,
    processAlive = pidExists,
    listProcesses = listAvdEmulatorProcesses,
    captureIdentity = captureProcessIdentity,
    inspectIdentity = inspectProcessIdentity,
    signal = (pid: number, name: NodeJS.Signals) => signalProcessTree(pid, name, { platform }),
    directoryExists = (path: string) => statSync(path).isDirectory(),
    crashHandlerPids = emulatorCrashHandlerPids,
    killCrashHandler = (pid: number) => signalProcessTree(pid, 'SIGKILL', { platform }),
    now = Date.now,
    sleep = sleepSync,
  }: {
    timeoutMs?: number;
    pollMs?: number;
    signalGraceMs?: number;
    platform?: NodeJS.Platform;
    resolveDirectory?: typeof ownedAvdDirectory;
    readProcessId?: (path: string) => number | null;
    processAlive?: (pid: number) => boolean;
    listProcesses?: typeof listAvdEmulatorProcesses;
    captureIdentity?: typeof captureProcessIdentity;
    inspectIdentity?: typeof inspectProcessIdentity;
    signal?: (pid: number, name: NodeJS.Signals) => void;
    directoryExists?: (path: string) => boolean;
    crashHandlerPids?: (qemuPid: number) => number[];
    killCrashHandler?: (pid: number) => void;
    now?: () => number;
    sleep?: (ms: number) => void;
  } = {},
): void {
  const { directory, processId } = resolveAvdProcess(avdName, { platform, resolveDirectory, readProcessId });
  const identities = new Map<number, ProcessRecord | null>();
  for (const pid of scanAvdEmulatorProcesses(avdName, platform, listProcesses)) {
    const captured = captureIdentity(pid);
    identities.set(pid, captured.ok ? { pid, processToken: captured.token } : null);
  }
  if (processId === null && identities.size === 0) {
    if (shutdown) throw new Error(`Could not find the emulator process lock for owned AVD ${avdName}.`);
    return;
  }
  const exited = (pid: number) => {
    const record = identities.get(pid);
    if (!record) return !processAlive(pid);
    const status = inspectIdentity(record);
    return status === 'gone' || status === 'different';
  };
  const running = () => {
    const pids = [...identities.keys()].filter((pid) => !exited(pid));
    if (processId !== null && !identities.has(processId) && processAlive(processId)) pids.push(processId);
    return pids;
  };
  const waitUntil = (until: number) => {
    for (;;) {
      if (running().length === 0) return true;
      const remaining = until - now();
      if (remaining <= 0) return false;
      sleep(Math.min(pollMs, remaining));
    }
  };
  const started = now();
  const deadline = started + timeoutMs;
  if (shutdown) {
    shutdown(Math.max(1, Math.floor(timeoutMs / 2)));
    waitUntil(started + Math.floor(timeoutMs / 2));
  }
  for (const name of ['SIGTERM', 'SIGKILL'] as const) {
    const verified = running().filter((pid) => {
      const record = identities.get(pid);
      return record && inspectIdentity(record) === 'same';
    });
    if (verified.length === 0) break;
    for (const pid of verified) {
      try {
        signal(pid, name);
      } catch {}
    }
    if (waitUntil(name === 'SIGTERM' ? Math.min(deadline, now() + signalGraceMs) : deadline)) break;
  }
  waitUntil(deadline);
  const left = new Set(running());
  for (const pid of scanAvdEmulatorProcesses(avdName, platform, listProcesses)) {
    if (!identities.has(pid) || !exited(pid)) left.add(pid);
  }
  if (left.size) {
    const unverified = [...left].filter((pid) => !identities.get(pid));
    throw new Error(
      `Owned AVD ${avdName} did not finish shutting down within ${Math.ceil(timeoutMs / 1000)}s: ` +
        `emulator process ${[...left].join(', ')} is still running` +
        (unverified.length
          ? ` (Stim could not verify the identity of ${unverified.join(', ')}, so it sent no signal)`
          : '') +
        '.',
    );
  }
  if (platform === 'win32' && processId !== null) {
    const handlerDeadline = now() + CRASH_HANDLER_EXIT_TIMEOUT_MS;
    for (const handler of crashHandlerPids(processId)) {
      while (processAlive(handler) && now() < handlerDeadline) sleep(pollMs);
      if (processAlive(handler)) {
        killCrashHandler(handler);
        if (processAlive(handler))
          throw new Error(`Crashpad handler ${handler} for owned AVD ${avdName} stayed alive.`);
      }
    }
  }
  if (!directoryExists(directory)) {
    throw new Error(`Could not verify the content directory for owned AVD ${avdName} after shutdown.`);
  }
}

const EMU_AVD_NAME_TIMEOUT_MS = 10_000;

export function getAvdNameForSerial(
  serial: string,
  { timeoutMs = EMU_AVD_NAME_TIMEOUT_MS }: { timeoutMs?: number } = {},
): string | null {
  const out = getExecutor().runQuiet(`${androidTool('adb')} -s ${serial} emu avd name`, {
    timeoutMs: Math.min(timeoutMs, EMU_AVD_NAME_TIMEOUT_MS),
    killSignal: 'SIGKILL',
  });
  if (!out) return null;
  return out.split('\n')[0]?.trim() || null;
}

export function resolveOwnedAvdSerial(avdName: string, opts: { timeoutMs?: number } = {}): ResolvedAvdSerial {
  return ownedAvdSerialResolver(opts)(avdName);
}

function once<T>(read: () => T): () => T {
  let result: { value: T } | { error: unknown } | undefined;
  return () => {
    if (!result) {
      try {
        result = { value: read() };
      } catch (error) {
        result = { error };
      }
    }
    if ('error' in result) throw result.error;
    return result.value;
  };
}

/**
 * `resolveOwnedAvdSerial` for several AVDs against one reading of the AVD list, `adb devices`, and
 * each emulator's AVD name. The timeout budget starts when the resolver is created.
 */
export function ownedAvdSerialResolver({ timeoutMs }: { timeoutMs?: number } = {}): (
  avdName: string,
) => ResolvedAvdSerial {
  const started = Date.now();
  const remaining = () => ({
    timeoutMs: timeoutMs === undefined ? undefined : Math.max(1, timeoutMs - (Date.now() - started)),
  });
  const avds = once(() => listAvds(remaining()));
  const adb = once(() => listAdbDevices(remaining()));
  const names = new Map<string, string | null>();
  const avdNameOf = (serial: string) => {
    if (!names.has(serial)) names.set(serial, getAvdNameForSerial(serial, remaining()));
    return names.get(serial);
  };
  return (avdName) => {
    if (!avds().includes(avdName)) return { missing: true };
    if (!isStimOwnedAvd(avdName)) return { notOwned: true };
    const devices = adb();
    const candidates = [
      ...devices.emulators,
      ...devices.unhealthy.filter((entry) => entry.kind === 'emulator' && entry.consolePort !== undefined),
    ];
    const match = candidates.find((e) => avdNameOf(e.serial) === avdName);
    if (match) return { serial: match.serial };
    return { notRunning: true };
  };
}
