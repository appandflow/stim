import type { NdjsonRecord } from '../../ndjson.ts';

// os_log only reaches a process's stderr when OS_ACTIVITY_DT_MODE is set in its
// environment; without it `devicectl --console` carries plain stdout/stderr
// writes alone, and React Native logs through os_log (React/Base/RCTLog.mm).
export const CONSOLE_ENV: Record<string, string> = { OS_ACTIVITY_DT_MODE: 'enable' };

// devicectl passes everything after `--`, and simctl launch --initialUrl
// (engine/app-install.ts) passes trailing argv, to the app. NSUserDefaults
// reads the argument domain ahead of the persisted one, so these turn
// expo-dev-menu's auto-launch and floating button off for this launch without
// writing to the persisted domain -- which devicectl cannot do at all (it has
// no `defaults` command) and which simctl only needs for launches it did not
// make.
export const DEV_MENU_LAUNCH_ARGS: readonly string[] = [
  '-EXDevMenuShowsAtLaunch',
  '0',
  '-EXDevMenuShowFloatingActionButton',
  '0',
];

// Anchored, because a message that merely quotes one of these is an app
// logging about a crash, not a crash. Swift prints its own file:line first.
const FATAL_MARKERS: RegExp[] = [
  /^\*\*\* Terminating app due to uncaught exception/,
  /^libc\+\+abi: terminating/,
  /^\*\*\* Assertion failure in/,
  /^(?:\S+:\d+: )?Fatal error: /,
];

const RUST_PANIC = /^thread '.*' (?:\(\d+\) )?panicked at \S/;
const RUST_PANIC_MESSAGE_LINES = 8;
const RUST_PANIC_END = /^(?:note: |stack backtrace:$|thread caused non-unwinding panic)/;

/**
 * Each Rust panic in an app's stderr with its message. rustc prints the `note:` backtrace hint after the first panic
 * of a process only, and a blank line before the next panic's header, so a message ends there; with neither within
 * a few lines it keeps its first line alone rather than the app output after it.
 */
export function rustPanics(text: string): string[] {
  const lines = text.split('\n').map((line) => line.replace(/\r$/, ''));
  const ends = (index: number) =>
    RUST_PANIC_END.test(lines[index] ?? '') ||
    RUST_PANIC.test(lines[index] ?? '') ||
    (lines[index] === '' && RUST_PANIC.test(lines[index + 1] ?? ''));
  const panics: string[] = [];
  lines.forEach((header, index) => {
    if (!RUST_PANIC.test(header)) return;
    let end = index + 1;
    while (end <= index + RUST_PANIC_MESSAGE_LINES && end < lines.length && !ends(end)) end++;
    const message = ends(end) ? lines.slice(index + 1, end) : lines.slice(index + 1, index + 2);
    panics.push([header, ...message].join('\n'));
  });
  return panics;
}

export const TOOL_ERROR_PREFIX = 'ERROR: ';
export const CONSOLE_RUN_ACCEPT = 'console-run-accept';
/** How long the console's helper waits for devicectl's process group to end after SIGTERM before killing it. */
export const CONSOLE_STOP_MS = 3000;

const MIRROR_LINE =
  /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+[+-]\d{4}) (.+?)\[(\d+):(\d+)\] ?(?:\[([^\]\s]+)\] )?([\s\S]*)$/;

export function deviceConsoleLevel(message: unknown): string {
  const text = typeof message === 'string' ? message : '';
  return FATAL_MARKERS.some((marker) => marker.test(text)) ? 'fatal' : 'info';
}

export function parseDeviceConsoleLine(
  line: string,
  { now = Date.now }: { now?: () => number } = {},
): NdjsonRecord | null {
  if (typeof line !== 'string') return null;
  const text = line.replace(/\r$/, '').trimEnd();
  if (!text.trim()) return null;

  const match = MIRROR_LINE.exec(text);
  const record: NdjsonRecord = {
    ts: now(),
    src: 'device',
    level: 'info',
    msg: text,
    raw: true,
  };
  if (!match) {
    // devicectl's own diagnostics share the app's stderr but never carry a
    // mirror prefix, so this prefix is only theirs on an unmatched line.
    record.level = text.startsWith(TOOL_ERROR_PREFIX) ? 'error' : deviceConsoleLevel(text);
    return record;
  }

  const [, timestamp, proc, pid, , category, message] = match;
  if (message === undefined || !message.trim()) return null;
  const parsed = Date.parse(timestamp as string);
  if (Number.isFinite(parsed)) record.ts = parsed;
  record.msg = message;
  record.level = deviceConsoleLevel(message);
  record.proc = `${proc}(${pid})`;
  if (category) record.category = category;
  return record;
}

export function deviceConsoleArgs({
  udid,
  bundleId,
  payloadUrl = null,
}: {
  udid: string;
  bundleId: string;
  payloadUrl?: string | null;
}): string[] {
  const args = [
    'devicectl',
    'device',
    'process',
    'launch',
    '--quiet',
    '--device',
    udid,
    '--console',
    '--terminate-existing',
    '--environment-variables',
    JSON.stringify(CONSOLE_ENV),
  ];
  if (payloadUrl) args.push('--payload-url', payloadUrl);
  args.push(bundleId);
  if (payloadUrl) args.push('--', ...DEV_MENU_LAUNCH_ARGS);
  return args;
}
