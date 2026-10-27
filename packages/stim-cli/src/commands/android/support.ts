import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { relative } from 'node:path';
import type { StimContext } from '@stim-cli/core';
import { killOnAbort } from '../../workspace/git-read.ts';
import type { SettingsObject, SettingScope } from '@stim-cli/core/state';
import { decideSystemImage, type AndroidImageInstallPolicy } from '../../devices/android-image.ts';
import {
  androidDeviceAbi,
  androidSystemImageAbi,
  listInstalledSystemImages,
  androidHome,
  findBuildTool,
  emulatorDiskSpaceRemedy,
  emulatorFailureRemedy,
  extractEmulatorFailure,
  androidPoolCandidates,
  androidPoolNoCandidatesRefusal,
  emulatorProbeSession,
  listAdbDevicesAsync,
  physicalDeviceModel,
  probeEmulatorSerial,
  hostSystemImageArch,
  pickDefaultSystemImage,
  profileNeedsFoldFeature,
  type SystemImage,
} from '../../devices/android.ts';
import {
  layerNote,
  unknownAndroidDeviceProfileRefusal,
  unknownAndroidSystemImageRefusal,
} from '../../engine/device-capacity.ts';
import type { OwnedDeviceRecord } from '../../engine/device.ts';
import { getExecutor } from '../../exec.ts';
import { devClientScheme as configuredDevClientScheme, pickDevClientScheme } from '../dev-client.ts';
import { selectFromPool } from '../../engine/device-pool.ts';
import type { FailExtra } from './types.ts';
import type { AndroidLayout } from '../../workspace/settings.ts';

export const PLATFORM = 'android';

export function androidVariantSetting(settings: SettingsObject | null | undefined): string | null {
  const android = settings?.['android'];
  if (!android || typeof android !== 'object' || Array.isArray(android)) return null;
  const raw = (android as Record<string, unknown>)['variant'];
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;
}

export function resolveVariant(
  flag: string | null | undefined,
  settings: SettingsObject | null | undefined,
): string | null {
  const fromFlag = typeof flag === 'string' && flag.trim() !== '' ? flag.trim() : null;
  return fromFlag || androidVariantSetting(settings);
}

export function androidSystemImageSetting(settings: SettingsObject | null | undefined): string | null {
  const android = settings?.['android'];
  if (!android || typeof android !== 'object' || Array.isArray(android)) return null;
  const raw = (android as Record<string, unknown>)['systemImage'];
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;
}

export function resolveSystemImage(
  flag: string | null | undefined,
  settings: SettingsObject | null | undefined,
): string | null {
  const fromFlag = typeof flag === 'string' && flag.trim() !== '' ? flag.trim() : null;
  return fromFlag || androidSystemImageSetting(settings);
}

export function remoteAvdFlagRefusal({
  systemImageFlag,
  deviceProfileFlag,
  remoteBackend,
}: {
  systemImageFlag: string | null | undefined;
  deviceProfileFlag: string | null | undefined;
  remoteBackend: string | null;
}): { code: string; message: string; remedy: string } | null {
  if (!remoteBackend) return null;
  const given = [
    typeof systemImageFlag === 'string' && '--system-image',
    typeof deviceProfileFlag === 'string' && '--device-profile',
  ]
    .filter(Boolean)
    .join(' and ');
  if (!given) return null;
  return {
    code: 'STIM_BAD_ARG',
    message: `${given} ${given.includes(' and ') ? 'apply' : 'applies'} only to a local owned Android emulator; the ${remoteBackend} remote backend chooses its own device.`,
    remedy: `Drop ${given} for a remote run. For a local owned emulator, drop --remote and unset android.remote with \`stim settings unset android.remote --scope <machine|workspace|repo|committed>\`.`,
  };
}

export function systemImageRefusal({
  slot,
  flag,
  resolved,
  origin = null,
  physical,
  remoteBackend,
  listImages,
  installImages,
}: {
  slot?: string;
  flag: string | null | undefined;
  resolved: string | null;
  origin?: SettingScope | null;
  physical: boolean;
  remoteBackend: string | null;
  listImages: typeof listInstalledSystemImages;
  installImages: AndroidImageInstallPolicy;
}): { code: string; message: string; remedy: string } | null {
  if (slot && slot !== 'default' && remoteBackend)
    return {
      code: 'STIM_BAD_ARG',
      message: 'Named slots currently support local simulators and physical devices.',
      remedy: 'Use the default slot for a remote session.',
    };
  if (typeof flag === 'string' && flag.trim() === '') {
    return {
      code: 'STIM_BAD_ARG',
      message: '--system-image was given an empty id.',
      remedy:
        'Pass `--system-image <id>` with an sdkmanager package id, e.g. "system-images;android-36;google_apis;arm64-v8a".',
    };
  }
  if (physical || remoteBackend) return null;
  if (!resolved) return null;
  let images;
  try {
    images = listImages();
  } catch (error) {
    return {
      code: NO_DEVICE,
      message: `Could not read the installed Android system images: ${(error as Error)?.message || error}`,
      remedy: 'Check that ANDROID_HOME points at a readable SDK, then try again.',
    };
  }
  const refusal = unknownAndroidSystemImageRefusal(resolved, images);
  if (!refusal) return null;
  const decided = decideSystemImage({ requested: resolved, installed: images, policy: installImages });
  if (decided.kind !== 'refuse') return null;
  const { message, remedy } = layerNote(
    { message: refusal.message, remedy: decided.remedy },
    'android.systemImage',
    flag,
    origin,
  );
  return { code: 'STIM_BAD_ARG', message, remedy };
}

export function resolveDeviceProfile(
  flag: string | null | undefined,
  settings: SettingsObject | null | undefined,
): string | null {
  const fromFlag = typeof flag === 'string' && flag.trim() !== '' ? flag.trim() : null;
  const android = settings?.['android'];
  const raw =
    android && typeof android === 'object' && !Array.isArray(android)
      ? (android as Record<string, unknown>)['deviceProfile']
      : undefined;
  return fromFlag || (typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null);
}

export async function deviceProfileRefusal({
  flag,
  resolved,
  origin = null,
  physical,
  remoteBackend,
  listProfiles,
  signal,
}: {
  flag: string | null | undefined;
  resolved: string | null;
  origin?: SettingScope | null;
  physical: boolean;
  remoteBackend: string | null;
  signal?: AbortSignal;
  listProfiles: (options?: { signal?: AbortSignal }) => string[] | Promise<string[]>;
}): Promise<{ code: string; message: string; remedy: string } | null> {
  if (typeof flag === 'string' && flag.trim() === '') {
    return {
      code: 'STIM_BAD_ARG',
      message: '--device-profile was given an empty id.',
      remedy: 'Pass `--device-profile <id>` with an id `avdmanager list device -c` prints, e.g. "pixel_fold".',
    };
  }
  if (physical || remoteBackend || !resolved) return null;
  let profiles;
  try {
    profiles = await listProfiles({ signal });
  } catch (error) {
    return {
      code: NO_DEVICE,
      message: `Could not list the Android hardware profiles with avdmanager: ${(error as Error)?.message || error}`,
      remedy:
        'Check that JAVA_HOME and ANDROID_HOME are set and the SDK command-line tools are installed, then try again.',
    };
  }
  const refusal = unknownAndroidDeviceProfileRefusal(resolved, profiles);
  if (!refusal) return null;
  const { message, remedy } = layerNote(refusal, 'android.deviceProfile', flag, origin);
  return { code: 'STIM_BAD_ARG', message, remedy };
}

export function foldableImageRefusal({
  profile,
  image,
  avdName,
  images,
  supportsFold,
}: {
  profile: string;
  image: string | null;
  avdName: string | null;
  images: () => SystemImage[];
  supportsFold: (pkg: string) => boolean;
}): { code: string; message: string; remedy: string } | null {
  if (!profileNeedsFoldFeature(profile) || !image || supportsFold(image)) return null;
  const compatible = pickDefaultSystemImage(images().filter((candidate) => supportsFold(candidate.pkg)))?.pkg;
  const subject = avdName
    ? `This workspace's emulator ${avdName} uses device profile ${profile} on ${image}`
    : `Device profile ${profile} with system image ${image}`;
  const message = `${subject}, which the emulator refuses to boot: ${profile} needs a system image with foldable support (SupportPixelFold in its advancedFeatures.ini).`;
  if (!compatible) {
    return {
      code: 'STIM_BAD_ARG',
      message,
      remedy: `Install an image with foldable support, e.g. \`sdkmanager "system-images;android-36;google_apis;${hostSystemImageArch()}"\`, then pass it with \`--system-image\`, or pick another \`--device-profile\`.`,
    };
  }
  return {
    code: 'STIM_BAD_ARG',
    message,
    remedy: avdName
      ? `Pass \`--system-image "${compatible}"\`: it replaces ${avdName} if that emulator never finished a boot. Otherwise add \`--slot <name>\` to create the foldable beside it.`
      : `Pass \`--system-image "${compatible}"\` (or set android.systemImage to it), or pick another \`--device-profile\`.`,
  };
}

export function isReleaseVariant(variant: string | null | undefined): boolean {
  return typeof variant === 'string' && /release$/i.test(variant.trim());
}

export const NO_FINGERPRINT = 'STIM_NO_FINGERPRINT';

export const NO_DEVICE = 'STIM_NO_DEVICE';

export const INSTALL_FAILED = 'STIM_INSTALL_FAILED';

export const LAUNCH_FAILED = 'STIM_LAUNCH_FAILED';

interface XmlNode {
  tag: string;
  attrs: Record<string, string | null>;
  children: XmlNode[];
  indent: number;
}

interface AaptTool {
  path: string;
  tool: string;
  version: string;
}

export function findAapt(
  home: string = androidHome(),
  {
    readDir = readdirSync,
    exists = existsSync,
  }: { readDir?: (path: string) => string[]; exists?: (path: string) => boolean } = {},
): AaptTool | null {
  const found = findBuildTool(['aapt', 'aapt2'], { home, readDir, exists });
  return found ? { path: found.path, tool: found.tool, version: found.version } : null;
}

export async function dumpApkManifest(
  apkPath: unknown,
  {
    exec = null,
    aapt = null,
    context,
  }: { exec?: import('../../exec.ts').Executor | null; aapt?: AaptTool | null; context?: StimContext } = {},
): Promise<string | null> {
  if (typeof apkPath !== 'string' || apkPath.trim() === '') return null;
  context?.signal.throwIfAborted();
  const tool = aapt || findAapt(androidHome(context?.env));
  if (!tool) return null;
  const e = exec || getExecutor();
  const args =
    tool.tool === 'aapt2'
      ? ['dump', 'xmltree', '--file', 'AndroidManifest.xml', apkPath]
      : ['dump', 'xmltree', apkPath, 'AndroidManifest.xml'];
  try {
    const out = await e.runFileAsync(tool.path, args, {
      timeoutMs: 30_000,
      declareFor: context,
      onSpawn: killOnAbort(context?.signal),
    });
    return typeof out === 'string' && out.includes('E: manifest') ? out : null;
  } catch {
    return null;
  }
}

export function parseXmltree(text: unknown): XmlNode {
  const root: XmlNode = { tag: '#root', attrs: {}, children: [], indent: -1 };
  const stack: XmlNode[] = [root];
  for (const raw of String(text ?? '').split('\n')) {
    const indent = raw.search(/\S/);
    if (indent < 0) continue;
    const line = raw.trim();
    const element = /^E: ([\w.:-]+)/.exec(line);
    if (element) {
      while (stack.length > 1 && stack[stack.length - 1]!.indent >= indent) stack.pop();
      const node: XmlNode = { tag: element[1]!, attrs: {}, children: [], indent };
      stack[stack.length - 1]!.children.push(node);
      stack.push(node);
      continue;
    }
    const attr = /^A: ([^(=]+?)(?:\(0x[0-9a-f]+\))?=(.*)$/.exec(line);
    if (attr && stack.length > 1) {
      const name = attr[1]!.replace(/^http:\/\/schemas\.android\.com\/apk\/res\/android:/, 'android:');
      const value = /^"((?:[^"\\]|\\.)*)"/.exec(attr[2]!);
      stack[stack.length - 1]!.attrs[name] = value ? value[1]! : null;
    }
  }
  return root;
}

function eachNode(node: XmlNode, fn: (node: XmlNode) => void): void {
  fn(node);
  for (const child of node.children) eachNode(child, fn);
}

interface ApkDevClientFacts {
  devClient: boolean;
  schemes: string[];
}

export function apkPackage(text: unknown): string | null {
  const root = parseXmltree(text);
  const manifest = root.children.find((c) => c.tag === 'manifest');
  const pkg = manifest?.attrs['package'];
  return typeof pkg === 'string' && pkg.trim() ? pkg.trim() : null;
}

export function apkDevClientFacts(text: unknown): ApkDevClientFacts {
  const root = parseXmltree(text);
  const facts: ApkDevClientFacts = { devClient: false, schemes: [] };
  let launchable: XmlNode | null = null;
  eachNode(root, (node) => {
    const name = node.attrs['android:name'];
    if (typeof name === 'string' && name.startsWith('expo.modules.devlauncher')) facts.devClient = true;
    if (node.tag !== 'activity' && node.tag !== 'activity-alias') return;
    const filters = node.children.filter((c) => c.tag === 'intent-filter');
    const isLauncher = filters.some((f) =>
      f.children.some((c) => c.tag === 'action' && c.attrs['android:name'] === 'android.intent.action.MAIN'),
    );
    if (!isLauncher || launchable) return;
    launchable = node;
    for (const filter of filters) {
      for (const data of filter.children) {
        if (data.tag !== 'data') continue;
        const scheme = data.attrs['android:scheme'];
        if (typeof scheme === 'string' && scheme.trim()) facts.schemes.push(scheme.trim());
      }
    }
  });
  return facts;
}

export async function androidDevClientScheme(
  root: string,
  apkPath: unknown,
  {
    exec = null,
    dump = dumpApkManifest,
    aapt = null,
    context,
  }: {
    context?: StimContext;
    exec?: import('../../exec.ts').Executor | null;
    dump?: typeof dumpApkManifest;
    aapt?: AaptTool | null;
  } = {},
): Promise<string | null | undefined> {
  const text = await dump(apkPath, { exec, aapt, context });
  if (text) {
    const facts = apkDevClientFacts(text);
    if (!facts.devClient) return undefined;
    const scheme = pickDevClientScheme(facts.schemes);
    if (scheme) return scheme;
  }
  return configuredDevClientScheme(root, null);
}

const EMULATOR_LOG_TAIL_LINES = 400;

export function noDeviceDiagnostic({
  reason,
  logFile,
  remedy,
  localEmulator = true,
  readLog = readEmulatorLogTail,
}: {
  reason: string;
  logFile: string;
  remedy: string;
  localEmulator?: boolean;
  readLog?: (file: string) => string;
}): { message: string; remedy: string; lines: string[]; logPath: string | null } {
  const text = localEmulator ? readLog(logFile) : '';
  const logPath = text.trim() ? logFile : null;
  const found = extractEmulatorFailure(text);
  const diskRemedy = localEmulator ? emulatorDiskSpaceRemedy([reason, ...found]) : null;
  if (found.length === 0) {
    return {
      message: reason,
      remedy: diskRemedy ?? remedy,
      lines: [],
      logPath,
    };
  }
  return {
    message: `${reason} The emulator reported: ${found[0]}`,
    remedy: diskRemedy ?? emulatorFailureRemedy(found),
    lines: found.slice(1),
    logPath,
  };
}

function readEmulatorLogTail(file: string): string {
  try {
    return readFileSync(file, 'utf-8').split('\n').slice(-EMULATOR_LOG_TAIL_LINES).join('\n');
  } catch {
    return '';
  }
}

export function displayPath(root: string, path: string): string {
  const rel = relative(root, path);
  return rel && !rel.startsWith('..') ? rel : path;
}

export async function pooledAndroidDevice({
  root,
  selectPool,
  listDevices,
  isEmulatorDevice,
  deviceModel,
  waitSeconds,
  noWait,
  now,
  warn,
}: {
  root: string;
  selectPool: typeof selectFromPool;
  listDevices: typeof listAdbDevicesAsync;
  isEmulatorDevice: typeof probeEmulatorSerial;
  deviceModel: typeof physicalDeviceModel;
  waitSeconds: number;
  noWait: boolean;
  now: () => number;
  warn: (line: string) => void;
}): Promise<{ device: OwnedDeviceRecord } | { code: string; message: string; remedy: string; extra: FailExtra }> {
  const probed = emulatorProbeSession(isEmulatorDevice);
  const pooled = await selectPool({
    root,
    platform: PLATFORM,
    idLabel: 'serial',
    list: async () => {
      const adb = await listDevices();
      return (await probed((isEmulator) => androidPoolCandidates(adb, isEmulator))).map((entry) => ({
        id: entry.serial,
      }));
    },
    noCandidates: async () => {
      const adb = await listDevices();
      const resolved = await probed((isEmulator) => androidPoolNoCandidatesRefusal(adb, isEmulator));
      return { message: resolved.error as string, remedy: resolved.remedy as string };
    },
    waitSeconds,
    noWait,
    now,
    warn,
  });
  if (pooled.status === 'refused') {
    const { code, message, remedy, lease } = pooled.refusal;
    return { code, message, remedy, extra: lease === null ? {} : { lease } };
  }
  return {
    device: {
      serial: pooled.candidate.id,
      deviceName: (await deviceModel(pooled.candidate.id)) ?? pooled.candidate.id,
      owned: false,
    },
  };
}

type AndroidRunOptions = {
  variant?: string;
  abi?: string;
  compiler?: string;
  buildProfile?: string;
  gradleProject?: string;
};

export function androidGradleProject(layout: AndroidLayout): string | null {
  return layout.custom ? `${layout.gradleRootRelative} ${layout.module}` : null;
}

export function androidJobLayout(layout: AndroidLayout): { gradleRoot?: string; module?: string } {
  return layout.custom ? { gradleRoot: layout.gradleRootRelative, module: layout.module } : {};
}

export async function androidBuildOptions({
  release,
  physical,
  device,
  variant,
  deviceAbi,
  compiler,
  buildProfile,
  targetAbiOnly = true,
  hostedAbi = null,
  gradleProject = null,
}: {
  release: boolean;
  physical: boolean;
  device: OwnedDeviceRecord;
  variant: string | null;
  deviceAbi: typeof androidDeviceAbi;
  compiler?: string;
  buildProfile?: string;
  targetAbiOnly?: boolean;
  hostedAbi?: string | null;
  gradleProject?: string | null;
}): Promise<{
  abi: string | null;
  runOptions: AndroidRunOptions;
  remoteRunOptions: AndroidRunOptions | null;
}> {
  let abi: string | null = targetAbiOnly ? hostedAbi : null;
  if (targetAbiOnly && !release && physical && device.serial) abi = await deviceAbi(device.serial);
  if (targetAbiOnly && !release && !physical) abi = androidSystemImageAbi(device.systemImage);

  const runOptions: AndroidRunOptions = {};
  if (variant) runOptions.variant = variant;
  if (gradleProject) runOptions.gradleProject = gradleProject;
  if (abi) runOptions.abi = abi;
  if (compiler) runOptions.compiler = compiler;
  if (buildProfile) runOptions.buildProfile = buildProfile;

  return {
    abi,
    runOptions,
    remoteRunOptions: Object.keys(runOptions).length === 0 ? null : runOptions,
  };
}
