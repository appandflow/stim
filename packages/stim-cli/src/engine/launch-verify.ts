import { isAppLaunchError } from '../command-output.ts';
import { join } from 'node:path';
import { getExecutor, type Executor } from '../exec.ts';
import { readNdjsonGenerations, type NdjsonRecord } from '../ndjson.ts';
import { DEV_MENU_LAUNCH_ARGS } from '../collector/ios-device.ts';
import { APP_READINESS_TIMEOUT_MS, appReadinessSignal, type AppReadiness } from './app-readiness.ts';
import { ANDROID_DISABLE_AUTO_LAUNCH_EXTRA, androidAppProcess, deviceShellArg } from './app-install.ts';

export type VerifyLaunchResult = {
  verified: boolean;
  record?: NdjsonRecord;
  errors?: NdjsonRecord[];
  fatal?: boolean;
  processAlive?: boolean | null;
  timedOut?: boolean;
  requested?: boolean;
  unattributed?: boolean;
  mode: string | null;
  waitedMs: number;
  readiness?: AppReadiness;
};

export const RELEASE_VERIFY_WAIT_MS = 3000;

export type ReleaseVerifyResult = {
  verified: boolean;
  reason?: 'no-pid' | 'exited' | 'probe-failed';
  waitedMs: number;
};

export async function verifyReleaseLaunch({
  pid,
  waitMs = RELEASE_VERIFY_WAIT_MS,
  alive = isProcessAlive,
  now = Date.now,
  sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)),
}: {
  pid?: number | null;
  waitMs?: number;
  alive?: (pid: number) => boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<unknown>;
}): Promise<ReleaseVerifyResult> {
  const startedAt = now();
  if (!pid) return { verified: false, reason: 'no-pid', waitedMs: 0 };
  await sleep(Math.max(0, waitMs));
  const waitedMs = now() - startedAt;
  return alive(pid) ? { verified: true, waitedMs } : { verified: false, reason: 'exited', waitedMs };
}

export async function verifyAndroidReleaseLaunch({
  serial,
  packageName,
  waitMs = RELEASE_VERIFY_WAIT_MS,
  exec = null,
  now = Date.now,
  sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)),
}: {
  serial: string;
  packageName: string;
  waitMs?: number;
  exec?: Executor | null;
  now?: () => number;
  sleep?: (ms: number) => Promise<unknown>;
}): Promise<ReleaseVerifyResult & { pid?: number | null }> {
  const e = exec || getExecutor();
  const startedAt = now();
  await sleep(Math.max(0, waitMs));
  const pid = androidAppProcess(serial, packageName, { exec: e });
  const waitedMs = now() - startedAt;
  if (pid === undefined) return { verified: false, reason: 'probe-failed', waitedMs };
  return pid === null ? { verified: false, reason: 'exited', waitedMs, pid: null } : { verified: true, waitedMs, pid };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

export const LAUNCH_UNVERIFIED = 'unverified';

export const LAUNCH_BUNDLING = 'bundling';

export const LAUNCH_FATAL = 'fatal';

export const VERIFY_TIMEOUT_MS = 20000;
export const STABILITY_WINDOW_MS = 3000;
const VERIFY_POLL_MS = 500;

const BUNDLE_EVENTS = new Set([
  'bundle_build_started',
  'bundle_build_done',
  'bundle_build_failed',
  'bundling_error',
  'transformer_error',
  'bundle_response_started',
  'bundle_response_finished',
  'bundle_response_failed',
]);

export function isBundleProof(
  record: unknown,
  since: number | string = 0,
  platform: 'ios' | 'android' | null = null,
): boolean {
  if (!record || typeof record !== 'object') return false;
  const rec = record as NdjsonRecord;
  const ts = Number(rec.ts);
  if (!Number.isFinite(ts) || ts < Number(since || 0)) return false;
  if (platform && recordPlatform(rec) !== platform) return false;
  if (typeof rec.event === 'string' && BUNDLE_EVENTS.has(rec.event)) return true;
  if (rec.src === 'metro' && typeof rec.msg === 'string' && expoBundleLine(rec.msg)) return true;
  return false;
}

const BUNDLE_URL_PATH = /\.bundle\b|\/_expo\/|expo-development-client/i;

export function isBundleRequestProof(
  record: unknown,
  since: number | string = 0,
  port: number | string | null = null,
  platform: 'ios' | 'android' | null = null,
): boolean {
  if (!record || typeof record !== 'object' || !port) return false;
  const rec = record as NdjsonRecord;
  const ts = Number(rec.ts);
  if (!Number.isFinite(ts) || ts < Number(since || 0)) return false;
  if (typeof rec.msg !== 'string') return false;
  if (rec.level === 'error' || rec.level === 'fatal') return false;
  const sourcePlatform = recordPlatform(rec);
  if (platform && sourcePlatform && sourcePlatform !== platform) return false;
  const digits = String(port).replace(/[^0-9]/g, '');
  if (!digits) return false;
  if (!new RegExp(`:${digits}\\b`).test(rec.msg)) return false;
  return BUNDLE_URL_PATH.test(rec.msg);
}

function expoBundleLine(msg: string) {
  return /\bBundl(?:ing|ed)\b/.test(msg);
}

function nativeLaunchFailure({
  readCrashes,
  since,
  platform,
  processAlive,
  mode,
  waitedMs,
}: {
  readCrashes: (() => NdjsonRecord[]) | null;
  since: number | string | undefined;
  platform: 'ios' | 'android' | null;
  processAlive: (() => boolean | null) | null;
  mode: string | null;
  waitedMs: number;
}): VerifyLaunchResult | null {
  if (!readCrashes) return null;
  const crashes = readCrashes().filter(
    (record) =>
      record.event === 'native_crash' && after(record, since) && recordCouldBelongToPlatform(record, platform),
  );
  return crashes.length
    ? { verified: false, fatal: true, errors: crashes, processAlive: processAlive?.() ?? null, mode, waitedMs }
    : null;
}

export async function verifyLaunch({
  slot,
  appPid,
  platformShared,
  logsDir,
  since,
  metroPort = null,
  platform = null,
  mode = null,
  requireBundleResponse,
  timeoutMs = VERIFY_TIMEOUT_MS,
  stabilityMs = STABILITY_WINDOW_MS,
  pollMs = VERIFY_POLL_MS,
  readRecords = null,
  readDeviceRecords = null,
  readClientRecords = null,
  readNativeCrashes = null,
  processAlive = null,
  onReadinessPending = null,
  now = Date.now,
  sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)),
}: {
  slot?: string;
  appPid?: number | null;
  platformShared?: boolean;
  logsDir?: string;
  since?: number | string;
  metroPort?: number | string | null;
  platform?: 'ios' | 'android' | null;
  mode?: string | null;
  requireBundleResponse?: boolean;
  timeoutMs?: number;
  stabilityMs?: number;
  pollMs?: number;
  readRecords?: (() => NdjsonRecord[]) | null;
  readDeviceRecords?: (() => NdjsonRecord[]) | null;
  readClientRecords?: (() => NdjsonRecord[]) | null;
  readNativeCrashes?: (() => NdjsonRecord[]) | null;
  processAlive?: (() => boolean | null) | null;
  onReadinessPending?: (() => void) | null;
  now?: () => number;
  sleep?: (ms: number) => Promise<unknown>;
} = {}): Promise<VerifyLaunchResult> {
  const delivered = (record: NdjsonRecord) => deliveryOwner(record, { slot, appPid, platformShared }) === 'this';
  const read = readRecords || (() => readMetroRecords(logsDir));
  const readDevice = readDeviceRecords || (() => readNdjson(logsDir, 'device.ndjson'));
  const readClient = readClientRecords || (() => readNdjson(logsDir, 'client.ndjson'));
  const startedAt = now();
  const bundleDeadline = startedAt + Math.max(0, timeoutMs);
  let proof: NdjsonRecord | null = null;
  let activity: NdjsonRecord | null = null;
  let stabilityDeadline: number | null = null;
  let pendingAt: number | null = null;
  let deliveryId: string | null = null;
  let runtimeLoadingAt: number | null = null;
  let runtimeStartedAt: number | null = null;
  let nextCrashCheck = startedAt + 1000;
  while (true) {
    const metroRecords = read().filter((record) => after(record, since));
    const bundleRecords = metroRecords.filter(
      (record) => (!requireBundleResponse || String(record.event).startsWith('bundle_response_')) && delivered(record),
    );
    const deviceRecords = readDevice().filter(
      (record) => after(record, since) && (slot === undefined || (record.slot ?? 'default') === slot),
    );
    const clientRecords = readClient().filter((record) => after(record, since) && !platformShared);
    if (now() >= nextCrashCheck) {
      nextCrashCheck = now() + 2000;
      const crash = nativeLaunchFailure({
        readCrashes: readNativeCrashes,
        since,
        platform,
        processAlive,
        mode,
        waitedMs: now() - startedAt,
      });
      if (crash) return crash;
    }
    if (deliveryId === null) {
      const request = bundleRecords.find(
        (record) =>
          record.event === 'bundle_response_started' &&
          typeof record.requestId === 'string' &&
          isBundleProof(record, since, platform),
      );
      if (request) {
        deliveryId = request.requestId as string;
        proof = null;
        stabilityDeadline = null;
      }
    }
    for (const record of bundleRecords) {
      if (isBundleProof(record, since, platform)) activity = record;
      const completed =
        deliveryId === null
          ? isBundleReadyProof(record, since, platform)
          : record.event === 'bundle_response_finished' &&
            record.requestId === deliveryId &&
            isBundleProof(record, since, platform);
      if (!proof && completed) {
        proof = record;
        stabilityDeadline = Number(record.ts) + Math.max(0, stabilityMs);
      }
    }
    const signals = deviceRecords
      .filter((record) => Number(record.ts) <= now())
      .toSorted((a, b) => Number(a.ts) - Number(b.ts));
    if (platform === 'android' && runtimeLoadingAt === null) {
      // ReactHostImpl's Loading JS Bundle state precedes asynchronous ReactInstance.loadJSBundle evaluation.
      const loading = signals.find(
        (record) =>
          record.src === 'device' &&
          record.platform === 'android' &&
          /^(?:unknown:)?BridgelessReact\(\d+\)$/.test(String(record.proc)) &&
          /^ReactHost\{\d+\}\.getOrCreateReactInstanceTask\(\): Loading JS Bundle$/.test(String(record.msg)) &&
          (stabilityDeadline === null || Number(record.ts) <= stabilityDeadline),
      );
      if (loading) runtimeLoadingAt = Number(loading.ts);
    }
    if (runtimeLoadingAt !== null && runtimeStartedAt === null) {
      const executing = signals.find(
        (record) =>
          record.src === 'device' &&
          record.platform === 'android' &&
          Number(record.ts) >= runtimeLoadingAt! &&
          (/^ReactNativeJS\(\d+\)$/.test(String(record.proc)) || appReadinessSignal(record, platform) !== null),
      );
      if (executing) runtimeStartedAt = Number(executing.ts);
    }
    const runtimeWaiting = runtimeLoadingAt !== null && runtimeStartedAt === null;
    const completedAt = proof ? Math.max(Number(proof.ts), runtimeStartedAt ?? 0) : null;
    if (completedAt !== null) stabilityDeadline = completedAt + Math.max(0, stabilityMs);
    const readinessDeadline = completedAt !== null ? completedAt + APP_READINESS_TIMEOUT_MS : bundleDeadline;
    if (pendingAt === null) {
      const pending = signals.find(
        (record) =>
          appReadinessSignal(record, platform) === 'pending' &&
          (runtimeWaiting || stabilityDeadline === null || Number(record.ts) <= stabilityDeadline),
      );
      if (pending) {
        pendingAt = Number(pending.ts);
        onReadinessPending?.();
      }
    }
    const ready =
      pendingAt !== null &&
      signals.some(
        (record) =>
          Number(record.ts) >= pendingAt! &&
          Number(record.ts) <= readinessDeadline &&
          appReadinessSignal(record, platform) === 'ready',
      );
    const bundleErrors = bundleRecords.filter(
      (record) =>
        isFatalLaunchError(record, platform) ||
        (deliveryId !== null &&
          record.event === 'bundle_response_failed' &&
          record.requestId === deliveryId &&
          isBundleProof(record, since, platform)),
    );
    if (bundleErrors.length) {
      const alive = processAlive ? processAlive() : null;
      const fatalRecord = bundleErrors[bundleErrors.length - 1];
      const fatalAt = Number(fatalRecord?.ts ?? since ?? 0);
      const errors = metroRecords.filter(
        (record) =>
          after(record, fatalAt) && recordCouldBelongToPlatform(record, platform) && isLaunchError(record, platform),
      );
      return {
        verified: false,
        fatal: true,
        errors,
        processAlive: alive,
        record: fatalRecord,
        mode,
        waitedMs: now() - startedAt,
        ...(pendingAt !== null ? { readiness: 'error' as const } : {}),
      };
    }

    if (proof && stabilityDeadline !== null && (pendingAt !== null || now() >= stabilityDeadline)) {
      const errorSince = pendingAt === null ? Number(proof.ts ?? since ?? 0) : Number(since ?? 0);
      const errors = [
        ...metroRecords.filter((record) => after(record, errorSince) && recordCouldBelongToPlatform(record, platform)),
        ...deviceRecords.filter((record) => after(record, errorSince) && recordCouldBelongToPlatform(record, platform)),
        ...clientRecords.filter((record) => after(record, errorSince) && recordCouldBelongToPlatform(record, platform)),
      ].filter((record) => isLaunchError(record, platform));
      const alive = processAlive ? processAlive() : null;
      const waitedMs = now() - startedAt;
      if (alive === false) {
        return {
          verified: false,
          fatal: true,
          errors,
          processAlive: alive,
          record: proof,
          mode,
          waitedMs,
          ...(pendingAt !== null ? { readiness: 'error' as const } : {}),
        };
      }
      const actionableErrors = errors.filter((record) => !isIosConnectionRefusal(record, platform));
      const appErrors = actionableErrors.some(isAppLaunchError);
      if ((!runtimeWaiting && pendingAt === null) || appErrors || ready || now() >= readinessDeadline) {
        return {
          verified: true,
          record: proof,
          errors: actionableErrors,
          processAlive: alive,
          mode,
          waitedMs,
          ...(pendingAt !== null ? { readiness: appErrors ? 'error' : ready ? 'ready' : 'timed-out' } : {}),
        };
      }
    }

    if ((!proof || runtimeWaiting) && now() >= bundleDeadline) {
      return bundleTimeoutOutcome({
        requested: findBundleRequest(deviceRecords, since, metroPort, platform) ?? activity,
        unattributed:
          metroRecords.find(
            (record) =>
              record.event === 'bundle_response_finished' &&
              deliveryOwner(record, { slot, appPid, platformShared }) === 'unknown' &&
              isBundleProof(record, since, platform),
          ) ?? null,
        processAlive,
        deviceRecords,
        platform,
        mode,
        waitedMs: now() - startedAt,
      });
    }
    const deadline = runtimeWaiting
      ? bundleDeadline
      : proof && pendingAt !== null
        ? readinessDeadline
        : (stabilityDeadline ?? bundleDeadline);
    await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
  }
}

function deliveryOwner(
  record: NdjsonRecord,
  { slot, appPid, platformShared }: { slot?: string; appPid?: number | null; platformShared?: boolean },
): 'this' | 'other' | 'unknown' {
  if (slot === undefined) return 'this';
  if (typeof record.clientPid === 'number' && appPid) return record.clientPid === appPid ? 'this' : 'other';
  return platformShared ? 'unknown' : 'this';
}

function bundleTimeoutOutcome({
  requested,
  unattributed,
  processAlive,
  deviceRecords,
  platform,
  mode,
  waitedMs,
}: {
  requested: NdjsonRecord | null;
  unattributed: NdjsonRecord | null;
  processAlive: (() => boolean | null) | null;
  deviceRecords: NdjsonRecord[];
  platform: 'ios' | 'android' | null;
  mode: string | null;
  waitedMs: number;
}): VerifyLaunchResult {
  if (processAlive?.() === false) {
    const errors = deviceRecords.filter(
      (record) =>
        recordCouldBelongToPlatform(record, platform) &&
        isLaunchError(record, platform) &&
        !isIosConnectionRefusal(record, platform),
    );
    return { verified: false, fatal: true, errors, processAlive: false, mode, waitedMs };
  }
  if (unattributed)
    return { verified: false, timedOut: true, unattributed: true, record: unattributed, mode, waitedMs };
  return requested
    ? { verified: false, timedOut: true, requested: true, record: requested, mode, waitedMs }
    : { verified: false, timedOut: true, mode, waitedMs };
}

function after(record: NdjsonRecord, since: number | string | undefined): boolean {
  const ts = Number(record.ts);
  return Number.isFinite(ts) && ts >= Number(since ?? 0);
}

function isLaunchError(record: NdjsonRecord, platform: 'ios' | 'android' | null): boolean {
  return record.level === 'error' || record.level === 'fatal' || isFatalLaunchError(record, platform);
}

// Apple's Network framework logs a failed TCP connection at Error level with a
// POSIX errno in the text, and 61 is ECONNREFUSED.
const TCP_REFUSAL = /^TCP Conn 0x[0-9a-f]+ Failed : error 0:61 \[61\]$/i;

function isIosConnectionRefusal(record: NdjsonRecord, platform: 'ios' | 'android' | null): boolean {
  return (
    platform === 'ios' &&
    record.src === 'device' &&
    record.level === 'error' &&
    typeof record.msg === 'string' &&
    TCP_REFUSAL.test(record.msg)
  );
}

function isFatalLaunchError(record: NdjsonRecord, platform: 'ios' | 'android' | null): boolean {
  if (platform && recordPlatform(record) !== platform) return false;
  return (
    record.event === 'bundle_build_failed' ||
    record.event === 'bundling_error' ||
    record.event === 'transformer_error' ||
    ((record.event === 'expo_stdout' || record.event === 'expo_stderr') &&
      typeof record.msg === 'string' &&
      /\bBundling failed\b/.test(record.msg))
  );
}

function isBundleReadyProof(
  record: unknown,
  since: number | string = 0,
  platform: 'ios' | 'android' | null = null,
): boolean {
  if (!isBundleProof(record, since, platform)) return false;
  const rec = record as NdjsonRecord;
  if (rec.event === 'bundle_build_done') return true;
  return rec.src === 'metro' && typeof rec.msg === 'string' && /\bBundled\b/.test(rec.msg);
}

function findBundleRequest(
  records: NdjsonRecord[],
  since: number | string | undefined,
  port: number | string | null,
  platform: 'ios' | 'android' | null,
): NdjsonRecord | null {
  for (const record of records) {
    if (isBundleRequestProof(record, since ?? 0, port, platform)) return record;
  }
  return null;
}

function recordCouldBelongToPlatform(record: NdjsonRecord, platform: 'ios' | 'android' | null): boolean {
  if (!platform) return true;
  const sourcePlatform = recordPlatform(record);
  return sourcePlatform === null || sourcePlatform === platform;
}

function recordPlatform(record: NdjsonRecord): 'ios' | 'android' | null {
  if (record.platform === 'ios' || record.platform === 'android') return record.platform;
  if (typeof record.msg !== 'string') return null;
  const match = record.msg.match(/\b(iOS|Android)\s+Bundl(?:ed|ing)\b/i);
  if (!match) return null;
  return match[1]!.toLowerCase() === 'ios' ? 'ios' : 'android';
}

export function readMetroRecords(logsDir: string | undefined): NdjsonRecord[] {
  return readNdjson(logsDir, 'metro.ndjson');
}

export function readCollectorRecords(logsDir: string | undefined): NdjsonRecord[] {
  return readNdjson(logsDir, 'device.ndjson');
}

function readNdjson(logsDir: string | undefined, name: string): NdjsonRecord[] {
  return logsDir ? readNdjsonGenerations(join(logsDir, name)) : [];
}

export function unattributedLaunchLines({
  platform,
  metroPort,
  slot = 'default',
  siblings,
}: {
  platform: 'ios' | 'android';
  metroPort: number | string | null;
  slot?: string;
  siblings: string[];
}): string[] {
  const others = siblings.length === 1 ? `Slot ${siblings[0]} also runs` : `Slots ${siblings.join(', ')} also run`;
  return [
    `UNVERIFIED: Metro delivered ${platform === 'ios' ? 'an iOS' : 'an Android'} bundle on port ${metroPort}, but not provably to this device`,
    `${others} ${platform} on this workspace's Metro, and this bundle request carried nothing that names the device that sent it.`,
    `Check this device directly: its screen through your device tool, or \`stim logs --slot ${slot} --source device\`.`,
  ];
}

export function unverifiedLaunchLines({
  platform,
  metroPort,
  waitedMs = VERIFY_TIMEOUT_MS,
  bundleId = null,
  udid = null,
  serial = null,
  devClientUrl: url = null,
  mode = null,
  remote = false,
  physical = false,
  devClient = false,
  lanOrigin = null,
  metroOrigin = null,
  localNetworkPending = false,
  component = null,
}: {
  platform: string;
  metroPort: number | string;
  waitedMs?: number;
  bundleId?: string | null;
  udid?: string | null;
  serial?: string | null;
  devClientUrl?: string | null;
  mode?: string | null;
  remote?: boolean;
  physical?: boolean;
  devClient?: boolean;
  lanOrigin?: string | null;
  metroOrigin?: string | null;
  localNetworkPending?: boolean;
  component?: string | null;
  // Explicit return type: isolatedDeclarations requires one at every module
  // boundary.
}): string[] {
  const seconds = Math.round(Number(waitedMs || 0) / 1000);
  const localNetwork = localNetworkPending && platform === 'ios' && physical;
  const lines = [
    `The app was started, but nothing fetched a bundle from this workspace's Metro (port ${metroPort}) within ${seconds}s.`,
  ];
  const origin = metroOrigin || `http://localhost:${metroPort}`;
  const picker = `If expo-dev-launcher's DEVELOPMENT SERVERS picker is showing, tap the entry for ${origin} -- NOT another workspace's, which would load a different project's bundle onto this device.`;
  let step = 0;
  const push = (text: string) => lines.push(`  ${++step}. ${text}`);
  lines.push(
    localNetwork
      ? `THE PHONE'S LOCAL NETWORK PERMISSION IS NOT GRANTED: the LAN connections this launch made failed with ` +
          `NSURLErrorDomain -1009 and the path reason "unsatisfied (Local network prohibited)", which is what iOS ` +
          'returns while the "would like to find and connect to devices on your local network" prompt is unanswered ' +
          `OR was answered Don't Allow earlier -- the log reads the same either way. Nothing the app sends reaches ` +
          `${lanOrigin || origin} until it is granted. Do this, in order:`
      : 'The app is launched; what is unproven is that it is talking to THIS dev server. Do this, in order:',
  );
  if (remote) {
    push(
      `Check that ${origin} is reachable FROM THE DEVICE's network, not just from this machine. That is the usual cause: a tunnel that stopped, or one this machine can reach and the device cannot.`,
    );
    push(
      'If an "Open in <app>?" alert or the expo-dev-launcher picker is showing on the remote device, confirm it with your device tool (`agent-device snapshot -i`, then `agent-device press`).',
    );
    lines.push(`Then check \`stim logs --source metro\`${mode ? ` (${mode})` : ''} for a bundle request.`);
    return lines;
  }
  if (platform === 'ios' && physical) {
    const target = lanOrigin || origin;
    const relaunch =
      `xcrun devicectl device process launch --device ${udid} --terminate-existing ` +
      (url ? `--payload-url '${url}' ` : '') +
      bundleId +
      (url ? ` -- ${DEV_MENU_LAUNCH_ARGS.join(' ')}` : '');
    if (localNetwork) {
      push(
        `See the prompt: agent-device alert get --platform ios --udid ${udid}. It reads the alert without opening ` +
          'anything, so it works while the app sits behind it.',
      );
      push(
        `Tap Allow: agent-device alert accept --platform ios --udid ${udid}. A second \`alert get\` then finds none.`,
      );
      push(
        'If the FIRST `alert get` already finds no alert, this permission was denied on an earlier run -- a ' +
          "Don't Allow persists across upgrade installs. Turn the app on by hand under Settings > Privacy & " +
          'Security > Local Network; there is no API for that switch.',
      );
      if (devClient) {
        push(
          'The app does NOT retry after the grant -- it stays on "Failed to load app ... The Internet connection ' +
            `appears to be offline." with a Reload button. Press it: agent-device snapshot -i --platform ios --udid ${udid}, ` +
            `then agent-device press 'label="Reload"' --platform ios --udid ${udid}. This launch carried ` +
            `-EXDevMenuShowsAtLaunch 0, so the Expo dev menu is not over the app; if the app was started another ` +
            `way and the menu is on screen, agent-device press 'label="Close"' --platform ios --udid ${udid} ` +
            'dismisses it.',
        );
        push(
          `Without agent-device, relaunching also recovers: ${relaunch}. It costs the device log -- it replaces the ` +
            'process the collector follows, so `stim logs --source device` stops for the rest of this run. Pressing ' +
            'Reload keeps the collector alive.',
        );
        push('By hand: tap Allow on the phone, then tap Reload on the app.');
      } else {
        push(
          'The app does NOT retry after the grant. A bare app is expected to show React Native\'s "Could not connect ' +
            'to development server" RedBox -- NOT VERIFIED ON HARDWARE, so read the screen rather than trusting that: ' +
            `agent-device snapshot -i --platform ios --udid ${udid}, then press its Reload button by the ref or label ` +
            'that snapshot reports.',
        );
        push(
          `Cleanest for a bare app: relaunch, which re-reads ip.txt: ${relaunch}. It costs the device log -- it ` +
            'replaces the process the collector follows, so `stim logs --source device` stops for the rest of this run.',
        );
        push('By hand: tap Allow on the phone, then tap Reload on the RedBox.');
      }
      lines.push(
        '`agent-device metro reload` does NOT recover either screen: it only reaches an app already connected to ' +
          "Metro's websocket, and this app never connected.",
      );
      lines.push(`Then check \`stim logs --source metro\`${mode ? ` (${mode})` : ''} for a bundle request.`);
      return lines;
    }
    push(
      `Tap Allow on the phone's "would like to find and connect to devices on your local network" prompt if it is showing, ` +
        'or turn the app on under Settings > Privacy & Security > Local Network. iOS gates every LAN connection behind ' +
        'that permission, it cannot be PRE-granted from this machine -- but once the prompt is up a device tool can ' +
        `accept it (agent-device alert get, then agent-device alert accept, both --platform ios --udid ${udid}) -- and ` +
        `until it is granted nothing the app sends reaches ${target}.`,
    );
    push(
      'Check the phone is on the same network as this Mac -- the same Wi-Fi SSID, not cellular, not a VPN -- and that ' +
        'the network does not isolate clients from each other.',
    );
    push(
      'Check macOS is not blocking inbound connections: System Settings > Network > Firewall, or ' +
        '`/usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate`. The gate on this machine passes either way, ' +
        'because macOS routes a host connection to its own address over loopback.',
    );
    push(
      `If this Mac has several network interfaces, ${target} may not be the one the phone shares: set ios.lanHost in ` +
        '.stim.json to the address it can reach.',
    );
    // The app takes ip.txt when it has no dev-client scheme, which is what the
    // install path routes on -- an Expo project without expo-dev-client is a
    // bare app here even though its dev server is expo-child.
    if (devClient) {
      push(picker);
      if (url && udid) {
        push(
          `Retry the deep link: xcrun devicectl device process launch --device ${udid} --terminate-existing ` +
            `--payload-url '${url}' ${bundleId} -- ${DEV_MENU_LAUNCH_ARGS.join(' ')}`,
        );
      }
    } else {
      lines.push(
        'AND READ THIS: a Debug device build with no dev client carries the JS bundle baked in when the artifact was ' +
          'built, so an unreachable Metro is silent. The app on screen is not broken -- it is running THAT bundle, ' +
          "which on a cache hit is another workspace's JS, not this workspace's.",
      );
    }
    lines.push(`Then check \`stim logs --source metro\`${mode ? ` (${mode})` : ''} for a bundle request.`);
    return lines;
  }
  if (platform === 'ios') {
    if (devClient) push(picker);
    if (url && udid) {
      push(`Retry the deep link: xcrun simctl openurl ${udid} '${url}'`);
    } else if (udid && bundleId) {
      push(`Re-launch: xcrun simctl launch --terminate-running-process ${udid} ${bundleId}`);
    }
  } else {
    if (url && serial) {
      push(
        `Re-send the dev-client deep link -- this is the command that points the app at THIS workspace's Metro: adb -s ${serial} shell am start -a android.intent.action.VIEW -d ${deviceShellArg(deviceShellArg(url))} --ez ${ANDROID_DISABLE_AUTO_LAUNCH_EXTRA} true`,
      );
    }
    if (devClient) push(picker);
    if (serial && bundleId) {
      const restart = component
        ? `adb -s ${serial} shell am force-stop ${bundleId} && adb -s ${serial} shell am start -n ${component}`
        : url
          ? `adb -s ${serial} shell am force-stop ${bundleId} && adb -s ${serial} shell am start -a android.intent.action.VIEW -d ${deviceShellArg(deviceShellArg(url))} --ez ${ANDROID_DISABLE_AUTO_LAUNCH_EXTRA} true`
          : `adb -s ${serial} shell am force-stop ${bundleId} && adb -s ${serial} shell monkey -p ${bundleId} 1`;
      push(`If the app is stuck, restart its process: ${restart}`);
    }
  }
  lines.push(`Then check \`stim logs --source metro\`${mode ? ` (${mode})` : ''} for a bundle request.`);
  return lines;
}
