import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { getExecutor } from './exec.ts';
import { androidClockOffset, parseLogcatLine } from './collector/android.ts';
import type { NdjsonRecord } from './ndjson.ts';
import { androidHome } from './sim/android.ts';
import { launchErrorPreview } from './launch-error-preview.ts';
import { deviceConsoleLevel } from './collector/ios-device.ts';
import { writeDiagnosticOnce } from './diagnostic-store.ts';
import { readLogRecords } from './logs-query.ts';
import { readWorkspaceLaunches, readWorkspaceState } from './supervisor/state.ts';
import { getProject } from './config.ts';
import { deviceLeasePath, fileLeaseIo, parseLease } from './engine/device-lease.ts';

export const IOS_CRASH_REPORT_RETRY =
  'iOS crash reports can take about a minute or longer to appear. Run `stim logs --errors` again for the native stack.';

interface CrashTarget {
  root?: string;
  platform: 'ios' | 'android';
  deviceId: string;
  appId: string;
  since: number;
  until?: number;
  appPath?: string | null;
  physical?: boolean;
}

interface CrashFrame {
  file: string;
  fn: string;
  line?: number;
  column?: number;
}
interface Image {
  path?: string;
  name?: string;
  uuid?: string;
  arch?: string;
  base?: number;
}
interface IosFrame {
  sourceFile?: string;
  sourceLine?: number;
  symbol?: string;
  symbolLocation?: number;
  imageIndex?: number;
  imageOffset?: number;
}
interface IosReport {
  captureTime?: string;
  procPath?: string;
  coalitionName?: string;
  incident?: string;
  pid?: number;
  bundleInfo?: { CFBundleIdentifier?: string };
  exception?: { type?: string; signal?: string };
  termination?: { namespace?: string; indicator?: string; reasons?: string[]; details?: string[] };
  asi?: Record<string, string[]>;
  faultingThread?: number;
  threads?: { triggered?: boolean; frames?: IosFrame[] }[];
  usedImages?: Image[];
}

/** Accepts only a report for this app, simulator and launch window. */
export function parseIosCrash(text: string, target: CrashTarget): { record: NdjsonRecord; report: IosReport } | null {
  try {
    const newline = text.indexOf('\n');
    const report = JSON.parse(text.slice(newline + 1)) as IosReport;
    const ts = Date.parse(report.captureTime ?? '');
    const simulator = `com.apple.CoreSimulator.SimDevice.${target.deviceId}`;
    if (
      report.bundleInfo?.CFBundleIdentifier !== target.appId ||
      report.coalitionName !== simulator ||
      !Number.isFinite(ts) ||
      ts < target.since ||
      ts > (target.until ?? Date.now() + 1000) ||
      !report.incident
    )
      return null;
    const thread = report.threads?.find((entry) => entry.triggered) ?? report.threads?.[report.faultingThread ?? -1];
    const stack: CrashFrame[] = (thread?.frames ?? []).map((frame) => {
      const image = report.usedImages?.[frame.imageIndex ?? -1];
      return {
        file: frame.sourceFile ?? image?.name ?? '<unknown image>',
        line: frame.sourceLine,
        fn: frame.symbol
          ? `${frame.symbol}${frame.symbolLocation ? ` + ${frame.symbolLocation}` : ''}`
          : `+0x${Number(frame.imageOffset ?? 0).toString(16)} [unsymbolicated]`,
      };
    });
    const details = [
      report.exception?.type,
      report.exception?.signal,
      report.termination?.namespace,
      report.termination?.indicator,
    ]
      .filter(Boolean)
      .join(' / ');
    const reasons = [
      ...(report.termination?.reasons ?? []),
      ...(report.termination?.details ?? []),
      ...Object.values(report.asi ?? {}).flat(),
    ].filter((line) => typeof line === 'string');
    return {
      report,
      record: {
        ts,
        src: 'device',
        platform: 'ios',
        level: 'fatal',
        event: 'native_crash',
        incident: report.incident,
        appId: target.appId,
        deviceId: target.deviceId,
        pid: report.pid,
        msg: `Native crash: ${details || 'process terminated'}${reasons.length ? `\n${reasons.join('\n')}` : ''}`,
        stack,
        rawReport: text,
      },
    };
  } catch {
    return null;
  }
}

/** Extracts crash-buffer groups only when their own process header names the target app. */
export function parseAndroidCrashes(text: string, target: CrashTarget, clockOffsetMs: number): NdjsonRecord[] {
  const entries = text
    .split('\n')
    .map((line) => parseLogcatLine(line, { clockOffsetMs }))
    .filter(
      (record): record is NdjsonRecord =>
        record !== null && Number(record.ts) >= target.since && Number(record.ts) <= (target.until ?? Infinity),
    );
  const groups: NdjsonRecord[][] = [];
  for (const entry of entries) {
    const last = groups.at(-1);
    if (!last || entry.proc !== last.at(-1)?.proc || /^\s*(?:FATAL EXCEPTION:|\*\*\* \*\*\*)/.test(entry.msg ?? ''))
      groups.push([entry]);
    else last.push(entry);
  }
  return groups.flatMap((group) => {
    const messages = group.map((record) => record.msg ?? '');
    const process = messages
      .map((line) => /^\s*(?:Process: (.+?), PID: \d+|pid: \d+, tid: \d+, name: .*?>>> (.*?) <<<)/.exec(line))
      .find(Boolean);
    const appId = process?.[1] ?? process?.[2];
    if (appId !== target.appId) return [];
    const msg = messages.join('\n');
    if (!/FATAL EXCEPTION:|signal \d+ \(/.test(msg)) return [];
    return [
      {
        ts: group[0]!.ts,
        deviceTs: group[0]!.deviceTs,
        pid: Number(/(?:PID: |pid: )(\d+)/.exec(msg)?.[1]) || undefined,
        src: 'device',
        platform: 'android',
        level: 'fatal',
        event: 'native_crash',
        appId,
        deviceId: target.deviceId,
        msg: `Native crash (Android)\n${msg}`,
        rawReport: msg,
      },
    ];
  });
}

function symbolicateIos(
  record: NdjsonRecord,
  report: IosReport,
  appPath: string | null | undefined,
  deadline: number,
): NdjsonRecord {
  if (!appPath || !existsSync(appPath) || !Array.isArray(record.stack)) return record;
  const thread = report.threads?.find((entry) => entry.triggered) ?? report.threads?.[report.faultingThread ?? -1];
  const stack = [...record.stack] as CrashFrame[];
  const verified = new Map<number, string | null>();
  for (const [index, frame] of (thread?.frames ?? []).entries()) {
    if (Date.now() >= deadline) break;
    if (frame.sourceFile && frame.sourceLine) continue;
    const imageIndex = frame.imageIndex ?? -1;
    const image = report.usedImages?.[imageIndex];
    if (
      !image?.path ||
      !image.uuid ||
      !image.arch ||
      !Number.isSafeInteger(image.base) ||
      !Number.isSafeInteger(frame.imageOffset)
    )
      continue;
    if (!verified.has(imageIndex)) {
      const marker = `${basename(appPath)}/`;
      const at = image.path.lastIndexOf(marker);
      const relative = at < 0 ? null : image.path.slice(at + marker.length);
      const binary = relative ? resolve(appPath, relative) : null;
      let matched: string | null = null;
      if (binary && binary.startsWith(resolve(appPath) + sep) && existsSync(binary)) {
        const uuids = getExecutor().runFileQuiet('xcrun', ['dwarfdump', '--uuid', binary], { timeoutMs: 2000 });
        if (uuids?.toLowerCase().includes(`uuid: ${image.uuid.toLowerCase()} (${image.arch.toLowerCase()})`))
          matched = binary;
      }
      verified.set(imageIndex, matched);
    }
    const binary = verified.get(imageIndex);
    if (!binary || Date.now() >= deadline) continue;
    const address = image.base! + frame.imageOffset!;
    if (!Number.isSafeInteger(address)) continue;
    const output = getExecutor().runFileQuiet(
      'xcrun',
      ['atos', '-o', binary, '-arch', image.arch, '-l', `0x${image.base!.toString(16)}`, `0x${address.toString(16)}`],
      { timeoutMs: 2000 },
    );
    if (output && !/^0x[0-9a-f]+$/i.test(output) && !/error:|cannot|unable/i.test(output)) {
      stack[index] = { file: image.name ?? basename(binary), fn: output };
    }
  }
  return { ...record, stack };
}

function symbolicateAndroid(record: NdjsonRecord, root: string | undefined, budget: number): NdjsonRecord {
  if (!root || typeof record.msg !== 'string' || !/#\d+ pc /.test(record.msg)) return record;
  const frames = [...record.msg.matchAll(/^\s*#\d+ pc ([0-9a-f]+)\s+(\S+)(.*)$/gim)];
  const stack: CrashFrame[] = frames.map(([, address, file, suffix]) => ({
    file: basename(file!),
    fn: `${suffix?.trim() || `0x${address}`} [captured native frame]`,
  }));
  let deadline = Math.min(Date.now() + 2000, budget - 1000);
  const ndks = join(androidHome(), 'ndk');
  let tools: string | undefined;
  try {
    for (const version of readdirSync(ndks).toSorted().toReversed()) {
      const prebuilt = join(ndks, version, 'toolchains/llvm/prebuilt');
      for (const host of readdirSync(prebuilt)) {
        const bin = join(prebuilt, host, 'bin');
        if (existsSync(join(bin, 'llvm-symbolizer'))) {
          tools = bin;
          break;
        }
      }
      if (tools) break;
    }
  } catch {}
  const files: string[] = [];
  const visit = (directory: string, depth: number) => {
    if (depth > 10 || files.length > 500 || Date.now() >= deadline) return;
    try {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) visit(join(directory, entry.name), depth + 1);
        else if (entry.isFile() && entry.name.endsWith('.so')) files.push(join(directory, entry.name));
      }
    } catch {}
  };
  if (tools) {
    for (const directory of ['android/app/src/main/jniLibs', 'android/app/build/intermediates/cxx', 'android/app/.cxx'])
      visit(join(root, directory), 0);
    deadline = budget;
    const byId = new Map<string, string | null>();
    for (const [index, [, address, file, suffix]] of frames.entries()) {
      if (Date.now() >= deadline) break;
      const id = /\(BuildId: ([0-9a-f]+)\)/i.exec(suffix ?? '')?.[1]?.toLowerCase();
      if (!id) continue;
      if (!byId.has(id)) {
        const binary = files
          .filter((path) => file!.endsWith('.apk') || basename(path) === basename(file!))
          .find((path) => {
            if (Date.now() >= deadline) return false;
            const notes = getExecutor().runFileQuiet(join(tools!, 'llvm-readelf'), ['--notes', path], {
              timeoutMs: 1000,
            });
            return /Build ID: ([0-9a-f]+)/i.exec(notes ?? '')?.[1]?.toLowerCase() === id;
          });
        byId.set(id, binary ?? null);
      }
      const binary = byId.get(id);
      if (!binary) continue;
      const output = getExecutor().runFileQuiet(
        join(tools, 'llvm-symbolizer'),
        ['--no-inlines', '--demangle', `--obj=${binary}`, `0x${address}`],
        { timeoutMs: 1000 },
      );
      const [fn, location] = output?.split('\n') ?? [];
      const match = /^(.*):(\d+):(\d+)$/.exec(location ?? '');
      if (fn && fn !== '??' && match && match[1] !== '??' && Number(match[2]) > 0) {
        stack[index] = { fn, file: match[1]!, line: Number(match[2]), column: Number(match[3]) };
      }
    }
  }
  const summary = record.msg
    .split('\n')
    .filter((line) => /Native crash|signal \d+|Abort message:|^pid:/.test(line))
    .join('\n');
  return {
    ...record,
    msg: summary,
    stack,
    symbolicationNote: stack.some((frame) => !frame.line)
      ? 'Native symbols are partial: unresolved frames retain crash-buffer symbols/addresses. Full captured report: stim logs --source device --json.'
      : undefined,
  };
}

export function simulatorConsolePaths(
  target: Pick<CrashTarget, 'deviceId' | 'appId' | 'since'>,
  prepare = false,
  remote = false,
): { stdout: string; stderr: string } | undefined {
  if (remote) return undefined;
  const container = getExecutor().runFileQuiet(
    'xcrun',
    ['simctl', 'get_app_container', target.deviceId, target.appId, 'data'],
    { timeoutMs: 2000 },
  );
  if (!container?.startsWith('/')) return undefined;
  const directory = join(container, 'Library/Caches/Stim');
  const key = createHash('sha256')
    .update(JSON.stringify([target.deviceId, target.appId, target.since]))
    .digest('hex');
  const paths = { stdout: join(directory, `launch-${key}.stdout`), stderr: join(directory, `launch-${key}.stderr`) };
  if (prepare) {
    try {
      mkdirSync(directory, { recursive: true });
      for (const path of Object.values(paths)) writeFileSync(path, '', { flag: 'wx' });
    } catch {
      return undefined;
    }
  }
  return paths;
}

function simulatorFatalConsole(target: CrashTarget): NdjsonRecord[] {
  const paths = simulatorConsolePaths(target);
  return Object.values(paths ?? {}).flatMap((path) => {
    try {
      if (statSync(path).size > 8 * 1024 * 1024) return [];
      if (target.until !== undefined && statSync(path).mtimeMs > target.until) return [];
      const text = readFileSync(path, 'utf8');
      const fatal = text.split('\n').filter((line) => deviceConsoleLevel(line) === 'fatal');
      if (!fatal.length) return [];
      return [
        {
          ts: Math.max(target.since + 1, statSync(path).mtimeMs),
          src: 'device',
          platform: 'ios',
          level: 'fatal',
          event: 'native_crash',
          appId: target.appId,
          deviceId: target.deviceId,
          incident: basename(path),
          pid: Number(/\[(\d+):\d+\]/.exec(text)?.[1]) || undefined,
          msg: fatal.join('\n'),
          rawReport: text,
          symbolicationNote: `Captured app stderr; the full operating system crash report is not available yet. ${IOS_CRASH_REPORT_RETRY}`,
        },
      ];
    } catch {
      return [];
    }
  });
}

/** Reads platform crash evidence without starting, stopping or modifying a device. */
export function captureNativeCrashes(target: CrashTarget, logsDir: string): NdjsonRecord[] {
  let records: NdjsonRecord[] = [];
  try {
    if (target.platform === 'ios' && !target.physical && process.platform === 'darwin') {
      const deadline = Date.now() + 4000;
      records = simulatorFatalConsole(target);
      const directory = join(homedir(), 'Library/Logs/DiagnosticReports');
      const reports = readdirSync(directory)
        .filter((name) => name.endsWith('.ips'))
        .map((name) => ({ path: join(directory, name), time: statSync(join(directory, name)).mtimeMs }))
        .filter(({ time }) => time >= target.since)
        .toSorted((a, b) => b.time - a.time)
        .slice(0, 50);
      const nativeReports = reports.flatMap(({ path }) => {
        if (Date.now() >= deadline) return [];
        if (statSync(path).size > 8 * 1024 * 1024) return [];
        const parsed = parseIosCrash(readFileSync(path, 'utf8'), target);
        return parsed ? [symbolicateIos(parsed.record, parsed.report, target.appPath, deadline)] : [];
      });
      if (nativeReports.length) records = nativeReports;
    } else if (target.platform === 'android') {
      const offset = androidClockOffset(target.deviceId);
      if (offset === null) return [];
      const text = getExecutor().runFileQuiet(
        'adb',
        ['-s', target.deviceId, 'logcat', '-b', 'crash', '-d', '-v', 'time,epoch', '-t', '2000'],
        { timeoutMs: 3000 },
      );
      const deadline = Date.now() + 4000;
      if (text)
        records = parseAndroidCrashes(text, target, offset).map((record) =>
          symbolicateAndroid(record, target.root, deadline),
        );
    }
  } catch {}
  for (const record of records) {
    try {
      const key = createHash('sha256')
        .update(JSON.stringify([record.deviceId, record.incident ?? record.deviceTs, record.rawReport]))
        .digest('hex');
      writeDiagnosticOnce(join(logsDir, `native-crash-${key}.ndjson`), `${JSON.stringify(record)}\n`);
    } catch {}
  }
  return records;
}

export function printNativeCrashReport(
  target: CrashTarget,
  logsDir: string,
  emit: (line: string) => void,
  remote: boolean,
): void {
  if (remote) return;
  for (const line of launchErrorPreview(captureNativeCrashes(target, logsDir), target.root)) emit(line);
}

export function captureWorkspaceCrashes(root: string, logsDir: string): void {
  const attempts = readLogRecords(logsDir).filter((record) => record.event === 'launch_attempt');
  const launches = readWorkspaceLaunches(root);
  for (const platform of ['ios', 'android'] as const) {
    try {
      const attempt = attempts.findLast((record) => record.platform === platform);
      if (!attempt || attempt.remote) continue;
      const { deviceId, appId } = attempt;
      const since = attempt.ts;
      const until = Date.now();
      if (
        typeof deviceId !== 'string' ||
        typeof appId !== 'string' ||
        typeof since !== 'number' ||
        !Number.isFinite(since)
      )
        continue;
      if (attempt.physical) {
        const holder = fileLeaseIo.readHolder(root)[platform];
        const lease = parseLease(fileLeaseIo.readLease(deviceLeasePath(platform, deviceId)));
        if (
          holder?.id !== deviceId ||
          !lease ||
          lease.platform !== platform ||
          lease.id !== deviceId ||
          lease.holder !== root ||
          lease.token !== holder.token ||
          Date.parse(lease.expiresAt) <= until ||
          !lease.grantedAt ||
          !Number.isFinite(Date.parse(lease.grantedAt)) ||
          Date.parse(lease.grantedAt) > since
        )
          continue;
      } else {
        const launch = launches[platform];
        if (
          !launch ||
          launch.deviceId !== deviceId ||
          launch.appId !== appId ||
          Date.parse(launch.launchedAt) !== since
        )
          continue;
        const configured = getProject(root)?.platforms?.[platform];
        if (!configured?.owned) continue;
        if (platform === 'ios' && configured.deviceUdid !== deviceId) continue;
        if (platform === 'android') {
          if (!configured.avdName) continue;
          const name = getExecutor().runFileQuiet('adb', ['-s', deviceId, 'emu', 'avd', 'name'], { timeoutMs: 2000 });
          if (name?.split('\n')[0]?.trim() !== configured.avdName) continue;
        }
      }
      captureNativeCrashes(
        {
          root,
          platform,
          deviceId,
          appId,
          since: Number(since),
          until,
          physical: attempt?.physical === true,
          appPath: (attempt?.appPath ?? readWorkspaceState(root)?.lastBuild?.appPath) as string | undefined,
        },
        logsDir,
      );
    } catch {}
  }
}
