import { getExecutor, type Executor } from '../exec.ts';
import { deviceHoldsApk, deviceHoldsBundle } from './installed-artifact.ts';
import { iosSimulatorFailureAdvice, listUserApps, uninstallIosApp } from '../devices/ios.ts';

export const INSTALL_ERROR = 'STIM_INSTALL_FAILED';
export const LAUNCH_ERROR = 'STIM_LAUNCH_FAILED';

export const DEFAULT_METRO_PORT = 8081;

const IOS_SCHEME_APPROVAL_DOMAIN = 'com.apple.launchservices.schemeapproval';
const IOS_SCHEME_APPROVAL_OPENER = 'com.apple.CoreSimulator.CoreSimulatorBridge';
const IOS_DEV_MENU_OFF_KEYS = ['EXDevMenuShowsAtLaunch', 'EXDevMenuShowFloatingActionButton'];
const DEV_CLIENT_ONBOARDING_QUERY = 'disableOnboarding=1';
const DEV_CLIENT_DISABLE_FAB_QUERY = 'disableFab=1';
export const ANDROID_DISABLE_AUTO_LAUNCH_EXTRA = 'EXDevMenuDisableAutoLaunch';

function describeIosSimulatorFailure(error: unknown, exec: Executor): string {
  const detail = describe(error);
  return (error as NodeJS.ErrnoException)?.code === 'ETIMEDOUT'
    ? `${detail}. ${iosSimulatorFailureAdvice(exec)}`
    : detail;
}

interface ExecOpt {
  exec?: Executor | null;
  now?: (() => number) | null;
}

export type IosInstallResult = {
  ok?: boolean;
  appPath?: string;
  skipped?: boolean;
  artifactDurationMs?: number;
  devClientPreparationDurationMs?: number;
  failed?: boolean;
  code?: string;
  reason?: string;
};

export type IosLaunchResult = {
  ok?: boolean;
  mode?: string;
  url?: string;
  jsLocation?: string;
  pid?: number | null;
  failed?: boolean;
  code?: string;
  reason?: string;
};

export type AndroidInstallResult = {
  ok?: boolean;
  apkPath?: string;
  skipped?: boolean;
  uninstalled?: boolean;
  note?: string;
  failed?: boolean;
  code?: string;
  reason?: string;
};

export type AndroidLaunchResult = {
  ok?: boolean;
  mode?: string;
  component?: string;
  devClientUrl?: string;
  devClientNote?: string | null;
  reversed?: string[];
  debugHttpHost?: string | null;
  debugHttpHostNote?: string | null;
  failed?: boolean;
  code?: string;
  reason?: string;
};

export function installIosApp(
  {
    udid,
    appPath,
    bundleId = null,
    devClientScheme = null,
    proveInstalled = true,
  }: {
    udid: string;
    appPath: string;
    bundleId?: string | null;
    devClientScheme?: string | null;
    proveInstalled?: boolean;
  },
  { exec = null, now = null }: ExecOpt = {},
): IosInstallResult {
  const e = exec || getExecutor();
  const artifactStartedAt = now?.();
  const skipped = bundleId && proveInstalled ? deviceHoldsBundle({ udid, bundleId, appPath }, { exec: e }) : false;
  if (!skipped) {
    try {
      e.runFile('xcrun', ['simctl', 'install', udid, appPath], { timeoutMs: 300000, killSignal: 'SIGKILL' });
    } catch (err) {
      return {
        failed: true,
        code: INSTALL_ERROR,
        reason: `simctl install failed for ${appPath}: ${describeIosSimulatorFailure(err, e)}`,
      };
    }
  }
  const artifactFinishedAt = now?.();
  const artifactDurationMs =
    artifactStartedAt !== undefined && artifactFinishedAt !== undefined
      ? artifactFinishedAt - artifactStartedAt
      : undefined;
  const preparationStartedAt = bundleId && devClientScheme ? artifactFinishedAt : undefined;
  if (bundleId && devClientScheme) {
    try {
      for (const key of IOS_DEV_MENU_OFF_KEYS) {
        e.runFile('xcrun', ['simctl', 'spawn', udid, 'defaults', 'write', bundleId, key, '-bool', 'false'], {
          timeoutMs: 60000,
        });
      }
      for (const key of iosSchemeApprovalKeys(bundleId, devClientScheme)) {
        e.runFile(
          'xcrun',
          ['simctl', 'spawn', udid, 'defaults', 'write', IOS_SCHEME_APPROVAL_DOMAIN, key, '-string', bundleId],
          { timeoutMs: 60000 },
        );
      }
    } catch (err) {
      return {
        failed: true,
        code: INSTALL_ERROR,
        reason: `Installed ${bundleId}, but could not prepare the dev client: ${describeIosSimulatorFailure(err, e)}`,
      };
    }
  }
  const devClientPreparationDurationMs =
    now && preparationStartedAt !== undefined ? now() - preparationStartedAt : undefined;
  const timing = {
    ...(artifactDurationMs === undefined ? {} : { artifactDurationMs }),
    ...(devClientPreparationDurationMs === undefined ? {} : { devClientPreparationDurationMs }),
  };
  return skipped ? { ok: true, appPath, skipped: true, ...timing } : { ok: true, appPath, ...timing };
}

export function clearOtherUserApps(
  { udid, keep }: { udid: string; keep?: string | null },
  {
    list = listUserApps,
    uninstall = uninstallIosApp,
  }: { list?: typeof listUserApps; uninstall?: typeof uninstallIosApp } = {},
): { listed: boolean; removed: string[]; failed: string[] } {
  const removed: string[] = [];
  const failed: string[] = [];
  let installed: string[];
  try {
    installed = list(udid);
  } catch {
    return { listed: false, removed, failed };
  }
  for (const bundleId of installed) {
    if (bundleId === keep) continue;
    try {
      uninstall(udid, bundleId);
      removed.push(bundleId);
    } catch {
      failed.push(bundleId);
    }
  }
  return { listed: true, removed, failed };
}

export function jsLocationValue(metroPort: number | string): string {
  return `localhost:${metroPort}`;
}

// On iOS expo-dev-launcher reads disableOnboarding off the PROJECT url only,
// not the outer deep link: EXDevLauncherController.m hands `devLauncherUrl.url`
// to EXDevLauncherURLHelper.disableOnboardingPopupIfNeeded. It sets
// EXDevMenuIsOnboardingFinished alone; EXDevMenuShowsAtLaunch is a separate
// preference. Android reads the flag on either url. DevLauncherController.kt's
// EXDevMenuDisableAutoLaunch extra does not disable the FAB; expo/expo#49651
// adds the outer disableFab query parameter for that.
export function devClientDeepLink(scheme: string, projectOrigin: string): string {
  const projectUrl = `${projectOrigin.replace(/\/+$/, '')}/?${DEV_CLIENT_ONBOARDING_QUERY}`;
  return `${scheme}://expo-development-client/?url=${encodeURIComponent(projectUrl)}&${DEV_CLIENT_DISABLE_FAB_QUERY}`;
}

export function devClientUrl(scheme: string, metroPort: number | string, host = 'localhost'): string {
  return devClientDeepLink(scheme, `http://${host}:${metroPort}`);
}

export function iosSchemeApprovalKeys(bundleId: string, devClientScheme: string): string[] {
  return [...new Set([bundleId, devClientScheme])].map((target) => `${IOS_SCHEME_APPROVAL_OPENER}-->${target}`);
}

export function parseLaunchedPid(text: unknown): number | null {
  if (typeof text !== 'string') return null;
  const match = text.trim().match(/:\s*(\d+)\s*$/);
  if (!match) return null;
  const pid = Number(match[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

export function iosAppProcess(
  udid: string,
  bundleId: string,
  { exec = null }: ExecOpt = {},
): number | null | undefined {
  const e = exec || getExecutor();
  let out = '';
  try {
    out = e.runFile('xcrun', ['simctl', 'spawn', udid, 'launchctl', 'list'], { timeoutMs: 2000 });
  } catch {
    return undefined;
  }
  const label = `UIKitApplication:${bundleId}[`;
  for (const line of out.split('\n')) {
    if (!line.includes(label)) continue;
    const pid = Number(line.trim().split(/\s+/)[0]);
    if (Number.isInteger(pid) && pid > 0) return pid;
  }
  return null;
}

function launchedIosAppAfterNoHandle(error: unknown, udid: string, bundleId: string, exec: Executor): number | null {
  const stderr = String((error as { stderr?: unknown })?.stderr ?? '');
  if (
    !stderr.includes('domain=NSPOSIXErrorDomain, code=3') ||
    !stderr.includes(`Application launch for '${bundleId}' did not return a process handle nor launch error.`)
  )
    return null;
  return iosAppProcess(udid, bundleId, { exec }) ?? null;
}

export function launchIosApp(
  {
    udid,
    bundleId,
    metroPort,
    devClientScheme = null,
    consolePaths,
  }: {
    udid: string;
    bundleId: string;
    metroPort: number | string | null;
    devClientScheme?: string | null;
    consolePaths?: { stdout: string; stderr: string };
  },
  { exec = null }: ExecOpt = {},
): IosLaunchResult {
  const e = exec || getExecutor();
  const launchArgs = [
    'simctl',
    'launch',
    ...(consolePaths ? [`--stdout=${consolePaths.stdout}`, `--stderr=${consolePaths.stderr}`] : []),
    udid,
    bundleId,
  ];
  if (metroPort !== null) {
    try {
      e.runFile(
        'xcrun',
        ['simctl', 'spawn', udid, 'defaults', 'write', bundleId, 'RCT_jsLocation', jsLocationValue(metroPort)],
        { timeoutMs: 60000 },
      );
    } catch (err) {
      return {
        failed: true,
        code: LAUNCH_ERROR,
        reason: `Could not point ${bundleId} at Metro port ${metroPort} (defaults write RCT_jsLocation): ${describeIosSimulatorFailure(err, e)}`,
      };
    }

    if (devClientScheme) {
      const url = devClientUrl(devClientScheme, metroPort);
      let launchedWithInitialUrl = false;
      try {
        if (consolePaths && iosAppProcess(udid, bundleId, { exec: e }) === null) {
          // Expo's EXDevLauncherController.initialUrlFromProcessInfo loads this
          // project directly; launch-then-openurl can create two React hosts.
          const initialUrl = new URL(url).searchParams.get('url')!;
          launchedWithInitialUrl = true;
          const pid = parseLaunchedPid(
            e.runFile('xcrun', [...launchArgs, '--initialUrl', initialUrl], { timeoutMs: 60000 }),
          );
          return { ok: true, mode: 'launch', url, jsLocation: jsLocationValue(metroPort), pid };
        }
        e.runFile('xcrun', ['simctl', 'openurl', udid, url], { timeoutMs: 60000 });
        return { ok: true, mode: 'openurl', url, jsLocation: jsLocationValue(metroPort) };
      } catch (err) {
        const pid = launchedWithInitialUrl ? launchedIosAppAfterNoHandle(err, udid, bundleId, e) : null;
        if (pid) return { ok: true, mode: 'launch', url, jsLocation: jsLocationValue(metroPort), pid };
        return {
          failed: true,
          code: LAUNCH_ERROR,
          reason: `simctl ${launchedWithInitialUrl ? `launch ${bundleId}` : `openurl ${url}`} failed: ${describeIosSimulatorFailure(err, e)}`,
        };
      }
    }
  }

  const preLaunchPid = iosAppProcess(udid, bundleId, { exec: e });
  try {
    const out = e.runFile('xcrun', launchArgs, { timeoutMs: 60000 });
    const result: IosLaunchResult = { ok: true, mode: 'launch', pid: parseLaunchedPid(out) };
    if (metroPort !== null) result.jsLocation = jsLocationValue(metroPort);
    return result;
  } catch (err) {
    const pid = preLaunchPid === null ? launchedIosAppAfterNoHandle(err, udid, bundleId, e) : null;
    if (pid) {
      const result: IosLaunchResult = { ok: true, mode: 'launch', pid };
      if (metroPort !== null) result.jsLocation = jsLocationValue(metroPort);
      return result;
    }
    return {
      failed: true,
      code: LAUNCH_ERROR,
      reason: `simctl launch ${bundleId} failed: ${describeIosSimulatorFailure(err, e)}`,
    };
  }
}

export function installConflictKind(text: unknown): 'signature' | 'downgrade' | null {
  const out = String(text ?? '');
  if (
    /INSTALL_FAILED_UPDATE_INCOMPATIBLE|INSTALL_PARSE_FAILED_INCONSISTENT_CERTIFICATES|signatures do not match/i.test(
      out,
    )
  ) {
    return 'signature';
  }
  if (/INSTALL_FAILED_VERSION_DOWNGRADE/i.test(out)) return 'downgrade';
  return null;
}

export const ADB_INSTALL_TIMEOUT_MS = 300_000;
const ADB_UNINSTALL_TIMEOUT_MS = 120_000;
const ADB_SHELL_TIMEOUT_MS = 30_000;
const ADB_SHELL_OPTIONS = { timeoutMs: ADB_SHELL_TIMEOUT_MS, killSignal: 'SIGKILL' } as const;

export function installAndroidApp(
  {
    serial,
    apkPath,
    packageName = null,
    allowUninstall = false,
  }: { serial: string; apkPath: string; packageName?: string | null; allowUninstall?: boolean },
  { exec = null }: ExecOpt = {},
): AndroidInstallResult {
  const e = exec || getExecutor();
  if (packageName && deviceHoldsApk({ serial, packageName, apkPath }, { exec: e })) {
    return { ok: true, apkPath, skipped: true };
  }
  const install = () => {
    e.runFile('adb', ['-s', serial, 'install', '-r', apkPath], { timeoutMs: ADB_INSTALL_TIMEOUT_MS });
  };
  try {
    install();
    return { ok: true, apkPath };
  } catch (err) {
    const conflict = installConflictKind(describe(err));
    if (!conflict || !allowUninstall || !packageName) {
      return { failed: true, code: INSTALL_ERROR, reason: `adb install failed for ${apkPath}: ${describe(err)}` };
    }
    try {
      e.runFile('adb', ['-s', serial, 'uninstall', packageName], {
        timeoutMs: ADB_UNINSTALL_TIMEOUT_MS,
        killSignal: 'SIGKILL',
      });
    } catch (uninstallErr) {
      return {
        failed: true,
        code: INSTALL_ERROR,
        reason:
          `adb install failed for ${apkPath} (${conflict}) and ${packageName} could not be uninstalled: ` +
          describe(uninstallErr),
      };
    }
    try {
      install();
    } catch (retryErr) {
      return {
        failed: true,
        code: INSTALL_ERROR,
        reason: `adb install failed for ${apkPath} even after uninstalling ${packageName}: ${describe(retryErr)}`,
      };
    }
    return {
      ok: true,
      apkPath,
      uninstalled: true,
      note:
        conflict === 'signature'
          ? `${packageName} was already installed with a different signer, so it was uninstalled (its data went with it) before this APK could be installed`
          : `${packageName} was already installed at a higher versionCode, so it was uninstalled (its data went with it) before this APK could be installed`,
    };
  }
}

export function parseResolvedActivity(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (/^No activity found/i.test(line)) return null;
    if (line.includes('=')) continue;
    if (!line.includes('/')) continue;
    return line;
  }
  return null;
}

function resolveLaunchActivity(serial: string, packageName: string, { exec = null }: ExecOpt = {}) {
  const e = exec || getExecutor();
  try {
    const out = e.runFile(
      'adb',
      [
        '-s',
        serial,
        'shell',
        'cmd',
        'package',
        'resolve-activity',
        '--brief',
        '-c',
        'android.intent.category.LAUNCHER',
        packageName,
      ],
      ADB_SHELL_OPTIONS,
    );
    return parseResolvedActivity(out);
  } catch {
    return null;
  }
}

export function reverseMetroPorts(
  {
    serial,
    metroPort,
    devicePorts = null,
  }: { serial: string; metroPort: number | string; devicePorts?: (number | string)[] | null },
  { exec = null }: ExecOpt = {},
): { ok?: boolean; reversed?: string[]; failed?: boolean; code?: string; reason?: string } {
  const e = exec || getExecutor();
  const pairs = (devicePorts ?? [metroPort]).map((device) => [device, metroPort]);
  for (const [device, host] of pairs) {
    try {
      e.runFile('adb', ['-s', serial, 'reverse', `tcp:${device}`, `tcp:${host}`], ADB_SHELL_OPTIONS);
    } catch (err) {
      return {
        failed: true,
        code: LAUNCH_ERROR,
        reason: `adb reverse tcp:${device} tcp:${host} failed on ${serial}: ${describe(err)}`,
      };
    }
  }
  return { ok: true, reversed: pairs.map(([device, host]) => `tcp:${device}->tcp:${host}`) };
}

const EMULATOR_HOST_LOOPBACK = '127.0.0.1';
const PHYSICAL_HOST_LOOPBACK = 'localhost';

function androidMetroHost(physical: boolean): string {
  return physical ? PHYSICAL_HOST_LOOPBACK : EMULATOR_HOST_LOOPBACK;
}

export function deviceShellArg(text: unknown): string {
  return `'${String(text).replace(/'/g, "'\\''")}'`;
}

export function debugHttpHostScript({
  packageName,
  host,
  dataDir = null,
}: {
  packageName: string;
  host: string;
  dataDir?: string | null;
}): string {
  const dir = dataDir || `/data/data/${packageName}`;
  const prefs = `shared_prefs/${packageName}_preferences.xml`;
  const tmp = `${prefs}.stim.tmp`;
  return [
    `cd ${dir} || exit 1`,
    'mkdir -p shared_prefs || exit 1',
    `printf '%s\\n' '<?xml version="1.0" encoding="utf-8" standalone="yes" ?>' '<map>' > ${tmp} || exit 1`,
    `if [ -f ${prefs} ]; then grep -v 'debug_http_host' ${prefs} | grep -v '<?xml' | grep -v '<map' | grep -v '</map>' >> ${tmp}; fi`,
    `printf '%s\\n' '    <string name="debug_http_host">${host}</string>' '</map>' >> ${tmp} || exit 1`,
    `mv ${tmp} ${prefs} || exit 1`,
    `grep -q '>${host}<' ${prefs} || exit 1`,
  ].join('\n');
}

export function writeDebugHttpHost(
  {
    serial,
    packageName,
    metroPort,
    physical = false,
  }: { serial: string; packageName: string; metroPort: number | string; physical?: boolean },
  { exec = null }: ExecOpt = {},
): { ok: boolean; host?: string; reason?: string } {
  const e = exec || getExecutor();
  const host = `${androidMetroHost(physical)}:${metroPort}`;
  const script = debugHttpHostScript({ packageName, host });
  try {
    e.runFile(
      'adb',
      ['-s', serial, 'shell', 'run-as', packageName, 'sh', '-c', deviceShellArg(script)],
      ADB_SHELL_OPTIONS,
    );
    return { ok: true, host };
  } catch (err) {
    return { ok: false, reason: `debug_http_host not written (${describe(err)}); relying on adb reverse` };
  }
}

export function androidDevClientUrl(scheme: string, metroPort: number | string, physical = false): string {
  return devClientUrl(scheme, metroPort, androidMetroHost(physical));
}

export function amStartError(text: unknown): string | null {
  const out = String(text ?? '');
  for (const raw of out.split('\n')) {
    const line = raw.trim();
    if (/^Error:/i.test(line)) return line;
  }
  return null;
}

export function openAndroidDevClientUrl(
  { serial, url, packageName }: { serial: string; url: string; packageName?: string },
  { exec = null }: ExecOpt = {},
): { ok?: boolean; url?: string; failed?: boolean; reason?: string } {
  const e = exec || getExecutor();
  let out;
  try {
    const args = [
      '-s',
      serial,
      'shell',
      'am',
      'start',
      '-a',
      'android.intent.action.VIEW',
      '-d',
      deviceShellArg(url),
      ...(packageName ? ['-p', packageName] : []),
      '--ez',
      ANDROID_DISABLE_AUTO_LAUNCH_EXTRA,
      'true',
    ];
    out = e.runFile('adb', args, ADB_SHELL_OPTIONS);
  } catch (err) {
    return { failed: true, reason: `am start -d ${url} failed on ${serial}: ${describe(err)}` };
  }
  const error = amStartError(out);
  if (error) return { failed: true, reason: `am start -d ${url} did not start anything on ${serial}: ${error}` };
  return { ok: true, url };
}

export function launchAndroidApp(
  {
    serial,
    packageName,
    metroPort,
    devClientScheme = null,
    physical = false,
  }: {
    serial: string;
    packageName: string;
    metroPort: number | string;
    devClientScheme?: string | null;
    physical?: boolean;
  },
  { exec = null }: ExecOpt = {},
): AndroidLaunchResult {
  const e = exec || getExecutor();
  const reversed = reverseMetroPorts({ serial, metroPort }, { exec: e });
  if (reversed.failed) return reversed;
  const prefs = writeDebugHttpHost({ serial, packageName, metroPort, physical }, { exec: e });
  let reversedPairs = reversed.reversed ?? [];
  if (!prefs.ok && Number(metroPort) !== DEFAULT_METRO_PORT) {
    const fallback = reverseMetroPorts({ serial, metroPort, devicePorts: [DEFAULT_METRO_PORT] }, { exec: e });
    if (fallback.failed) return fallback;
    reversedPairs = [...reversedPairs, ...(fallback.reversed ?? [])];
  }
  const wiring = {
    reversed: reversedPairs,
    debugHttpHost: prefs.ok ? prefs.host : null,
    debugHttpHostNote: prefs.ok ? null : prefs.reason,
  };

  let devClientNote = null;
  if (devClientScheme) {
    const url = androidDevClientUrl(devClientScheme, metroPort, physical);
    const opened = openAndroidDevClientUrl({ serial, url }, { exec: e });
    if (opened.ok) return { ok: true, mode: 'deep-link', devClientUrl: url, ...wiring };
    devClientNote = `${opened.reason}; fell back to the launcher activity`;
  }

  const component = resolveLaunchActivity(serial, packageName, { exec: e });
  if (component) {
    try {
      e.runFile('adb', ['-s', serial, 'shell', 'am', 'start', '-n', component], ADB_SHELL_OPTIONS);
      return { ok: true, mode: 'am-start', component, devClientNote, ...wiring };
    } catch (err) {
      return {
        failed: true,
        code: LAUNCH_ERROR,
        reason: `am start -n ${component} failed on ${serial}: ${describe(err)}`,
      };
    }
  }

  try {
    e.runFile('adb', ['-s', serial, 'shell', 'monkey', '-p', packageName, '1'], ADB_SHELL_OPTIONS);
    return { ok: true, mode: 'monkey', devClientNote, ...wiring };
  } catch (err) {
    return {
      failed: true,
      code: LAUNCH_ERROR,
      reason: `Could not launch ${packageName} on ${serial}: no launcher activity resolved and monkey failed: ${describe(err)}`,
    };
  }
}

export function launchAndroidReleaseApp(
  { serial, packageName }: { serial: string; packageName: string },
  { exec = null }: ExecOpt = {},
): AndroidLaunchResult {
  const e = exec || getExecutor();
  const component = resolveLaunchActivity(serial, packageName, { exec: e });
  if (component) {
    try {
      e.runFile('adb', ['-s', serial, 'shell', 'am', 'start', '-n', component], ADB_SHELL_OPTIONS);
      return { ok: true, mode: 'am-start', component };
    } catch (err) {
      return {
        failed: true,
        code: LAUNCH_ERROR,
        reason: `am start -n ${component} failed on ${serial}: ${describe(err)}`,
      };
    }
  }
  try {
    e.runFile('adb', ['-s', serial, 'shell', 'monkey', '-p', packageName, '1'], ADB_SHELL_OPTIONS);
    return { ok: true, mode: 'monkey' };
  } catch (err) {
    return {
      failed: true,
      code: LAUNCH_ERROR,
      reason: `Could not launch ${packageName} on ${serial}: no launcher activity resolved and monkey failed: ${describe(err)}`,
    };
  }
}

function describe(err: unknown) {
  const e = err as { stderr?: unknown; message?: unknown };
  const stderr = e?.stderr ? String(e.stderr).trim() : '';
  const message = e?.message ? String(e.message).trim() : String(err);
  return stderr ? `${message}: ${stderr}` : message;
}

export function parsePidof(text: unknown): number | null {
  const first = String(text ?? '')
    .trim()
    .split(/\s+/)[0];
  const pid = Number(first);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

export function parsePsPid(text: unknown, packageName: string): number | null {
  for (const raw of String(text ?? '').split('\n')) {
    const cols = raw.trim().split(/\s+/);
    if (cols.length < 2) continue;
    if (cols[cols.length - 1] !== packageName) continue;
    const pid = Number(cols[1]);
    if (Number.isFinite(pid) && pid > 0) return pid;
  }
  return null;
}

export function androidAppProcess(
  serial: string,
  packageName: string,
  { exec = null }: ExecOpt = {},
): number | null | undefined {
  const e = exec || getExecutor();
  try {
    const pid = parsePidof(e.runFile('adb', ['-s', serial, 'shell', 'pidof', packageName], ADB_SHELL_OPTIONS));
    if (pid !== null) return pid;
  } catch {}
  try {
    return parsePsPid(e.runFile('adb', ['-s', serial, 'shell', 'ps', '-A'], ADB_SHELL_OPTIONS), packageName);
  } catch {
    return undefined;
  }
}
