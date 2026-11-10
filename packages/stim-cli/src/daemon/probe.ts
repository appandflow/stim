import { getExecutor, type Executor } from '../exec.ts';

const RECENT_INPUT_MS = 120_000;
const PROBE_TIMEOUT_MS = 5000;
const SIMULATOR_BUNDLE_ID = 'com.apple.iphonesimulator';
const DEVICE_HUB_BUNDLE_ID = 'com.apple.dt.Devices';

/** `udid` null: the focused simulator cannot be read, so every booted simulator counts as in use. */
export type FocusedDeviceUse =
  | { platform: 'ios'; udid: string | null; idleMs: number }
  | { platform: 'android'; avdName: string; idleMs: number };

/** Milliseconds since the last keyboard, mouse or trackpad input, from `ioreg`'s IOHIDSystem `HIDIdleTime` (ns). */
export function parseHidIdleMs(output: string): number | null {
  const match = /"HIDIdleTime"\s*=\s*(\d+)/.exec(output);
  return match ? Math.floor(Number(match[1]) / 1e6) : null;
}

/** The frontmost app's bundle id, pid and executable from `lsappinfo info -only bundleid -only pid -only executablepath`. */
export function parseFrontApp(output: string): {
  bundleId: string | null;
  pid: number | null;
  executable: string | null;
} {
  const bundleId = /bundleID="([^"]+)"/.exec(output)?.[1] ?? null;
  const pid = Number(/\bpid = (\d+)/.exec(output)?.[1]);
  const executable = /executable path="([^"]+)"/.exec(output)?.[1] ?? null;
  return { bundleId, pid: Number.isInteger(pid) && pid > 0 ? pid : null, executable };
}

/** The AVD an emulator process runs, from its `-avd <name>` or `@<name>` argument. */
export function parseAvdName(args: string): string | null {
  return /(?:^|\s)-avd\s+(\S+)/.exec(args)?.[1] ?? /(?:^|\s)@(\S+)/.exec(args)?.[1] ?? null;
}

async function read(exec: Executor, file: string, args: string[], signal?: AbortSignal): Promise<string | null> {
  try {
    return await exec.runFileAsync(file, args, { timeoutMs: PROBE_TIMEOUT_MS, signal });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'STIM_CLAIM_UNAVAILABLE') throw error;
    signal?.throwIfAborted();
    return null;
  }
}

/**
 * The Simulator or emulator window a person used within the last two minutes: the HID idle time is under two
 * minutes and the frontmost app is Simulator.app (its focused device from `CurrentDeviceUDID` when readable),
 * Xcode 27's Device Hub, which records no readable focused device, or an emulator's `qemu-system-*` window (its AVD
 * from the process arguments). These reads need no permission. Null elsewhere, and on any other platform than macOS.
 */
export async function probeFocusedDeviceUse({
  platform = process.platform,
  exec = getExecutor(),
  signal,
}: { platform?: NodeJS.Platform; exec?: Executor; signal?: AbortSignal } = {}): Promise<FocusedDeviceUse | null> {
  if (platform !== 'darwin') return null;
  const idleMs = parseHidIdleMs(
    (await read(exec, 'ioreg', ['-r', '-c', 'IOHIDSystem', '-k', 'HIDIdleTime', '-d', '1'], signal)) ?? '',
  );
  if (idleMs === null || idleMs >= RECENT_INPUT_MS) return null;
  const asn = (await read(exec, 'lsappinfo', ['front'], signal))?.trim();
  if (!asn) return null;
  const front = parseFrontApp(
    (await read(
      exec,
      'lsappinfo',
      ['info', '-only', 'bundleid', '-only', 'pid', '-only', 'executablepath', asn],
      signal,
    )) ?? '',
  );
  if (front.bundleId === DEVICE_HUB_BUNDLE_ID) return { platform: 'ios', udid: null, idleMs };
  if (front.bundleId === SIMULATOR_BUNDLE_ID) {
    const udid = (
      await read(exec, 'defaults', ['read', 'com.apple.iphonesimulator', 'CurrentDeviceUDID'], signal)
    )?.trim();
    return { platform: 'ios', udid: udid || null, idleMs };
  }
  if (front.pid !== null && /(?:^|\/)qemu-system-[^/]*$/.test(front.executable ?? '')) {
    const avdName = parseAvdName((await read(exec, 'ps', ['-o', 'args=', '-p', String(front.pid)], signal)) ?? '');
    return avdName ? { platform: 'android', avdName, idleMs } : null;
  }
  return null;
}
