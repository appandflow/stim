import { totalmem } from 'node:os';
import type { MemoryCulprit } from '@stim-cli/core/state';
import type { Finding } from './diagnostics/doctor.ts';
import { getExecutor, type Executor } from './exec.ts';
import { formatBytes } from './fs-util.ts';

export interface TopProcess {
  pid: number;
  bytes: number;
  /** top's COMMAND column: the process name, cut to 16 characters. */
  name: string;
}

const GIB = 1024 ** 3;
const UNITS: Record<string, number> = { B: 1, K: 1024, M: 1024 ** 2, G: GIB, T: 1024 * GIB };
const GENERAL_FLOOR_BYTES = 8 * GIB;
const GENERAL_SHARE_OF_RAM = 0.25;
const TOP_ROWS = 20;

interface Restartable {
  name: string;
  matches: (process: TopProcess, commandLine: string | undefined) => boolean;
  /** A lower bar for a process that is normally small, so a leak shows before it reaches the general one. */
  bytes?: number;
  command: string;
  note: string;
}

const GRADLE_DAEMON = /\borg\.gradle\.launcher\.daemon\.bootstrap\.GradleDaemon\b/;
const KOTLIN_DAEMON = /\bKotlinCompileDaemon\b/;
const GRADLE_NOTE = 'Stim stops only idle daemons; the next build starts a new one.';

const RESTARTABLE: readonly Restartable[] = [
  {
    name: 'fseventsd',
    matches: ({ name }) => name === 'fseventsd',
    bytes: 2 * GIB,
    command: 'sudo killall fseventsd',
    note: 'launchd restarts it at once, and file watchers rescan their folders once.',
  },
  {
    name: 'Watchman',
    matches: ({ name }) => name === 'watchman',
    bytes: 2 * GIB,
    command: 'stim gc --delete --cache watchman',
    note: 'Stim stops the daemon only when no workspace uses it; the next Metro starts a fresh one.',
  },
  {
    name: 'Gradle daemon',
    matches: ({ name }, commandLine) => name === 'java' && GRADLE_DAEMON.test(commandLine ?? ''),
    command: 'stim gc --delete --cache gradle-daemons',
    note: GRADLE_NOTE,
  },
  {
    name: 'Kotlin daemon',
    matches: ({ name }, commandLine) => name === 'java' && KOTLIN_DAEMON.test(commandLine ?? ''),
    command: 'stim gc --delete --cache gradle-daemons',
    note: GRADLE_NOTE,
  },
];

/** Parses `top -l 1 -stats pid,mem,command` output: the rows after its `PID MEM COMMAND` header. */
export function parseTopMemory(output: string): TopProcess[] {
  const rows: TopProcess[] = [];
  let header = false;
  for (const line of output.split('\n')) {
    if (!header) {
      header = /^\s*PID\s+MEM\s+COMMAND\b/.test(line);
      continue;
    }
    const match = /^\s*(\d+)\s+(\d+(?:\.\d+)?)([BKMGT])[+-]?\s+(\S.*?)\s*$/.exec(line);
    if (match)
      rows.push({ pid: Number(match[1]), bytes: Math.round(Number(match[2]) * UNITS[match[3]!]!), name: match[4]! });
  }
  return rows;
}

/**
 * The processes whose footprint is abnormal: at least a quarter of physical memory and 8 GiB, or a known leaker's
 * lower bar. A known safe-to-restart process carries its command; any other carries none.
 */
export function findMemoryCulprits(
  processes: readonly TopProcess[],
  totalBytes: number,
  commandLines: ReadonlyMap<number, string> = new Map(),
): MemoryCulprit[] {
  const general = Math.max(GENERAL_FLOOR_BYTES, totalBytes * GENERAL_SHARE_OF_RAM);
  const culprits: MemoryCulprit[] = [];
  for (const row of processes) {
    const known = RESTARTABLE.find((entry) => entry.matches(row, commandLines.get(row.pid)));
    if (row.bytes < Math.min(general, known?.bytes ?? general)) continue;
    culprits.push({
      pid: row.pid,
      name: known?.name ?? row.name,
      bytes: row.bytes,
      command: known?.command ?? null,
      note: known?.note ?? null,
    });
  }
  return culprits.toSorted((a, b) => b.bytes - a.bytes);
}

/** One sentence per culprit: its size and, when Stim knows one, the command that frees it. */
export function memoryCulpritAdvice(culprits: readonly MemoryCulprit[] | null): string | null {
  if (!culprits?.length) return null;
  return culprits
    .map((culprit) => {
      const uses = `${culprit.name} (pid ${culprit.pid}) uses ${formatBytes(culprit.bytes)} of memory`;
      return culprit.command
        ? `${uses}; run \`${culprit.command}\` to free it: ${culprit.note}`
        : `${uses}; Stim knows no safe restart for it, so ask before quitting it.`;
    })
    .join(' ');
}

/**
 * The abnormal processes by footprint, from the setuid `top`: unlike `proc_pid_rusage` without root, it reads
 * root-owned daemons such as fseventsd, and unlike `ps` RSS it counts compressed and swapped memory. Null off macOS
 * or when `top` fails.
 */
export function readMemoryCulprits(
  exec: Executor = getExecutor(),
  platform: NodeJS.Platform = process.platform,
  totalBytes: number = totalmem(),
): MemoryCulprit[] | null {
  if (platform !== 'darwin') return null;
  const output = exec.runFileQuiet(
    '/usr/bin/top',
    ['-l', '1', '-o', 'mem', '-n', String(TOP_ROWS), '-stats', 'pid,mem,command'],
    { timeoutMs: 10_000 },
  );
  if (output === null) return null;
  const processes = parseTopMemory(output);
  const java = processes.filter((entry) => entry.name === 'java').map((entry) => entry.pid);
  const commandLines = new Map<number, string>();
  if (java.length) {
    const listed = exec.runFileQuiet('/bin/ps', ['-ww', '-o', 'pid=,command=', '-p', java.join(',')], {
      timeoutMs: 5000,
    });
    for (const line of listed?.split('\n') ?? []) {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (match) commandLines.set(Number(match[1]), match[2]!);
    }
  }
  return findMemoryCulprits(processes, totalBytes, commandLines);
}

/** Doctor findings for the culprits. Watchman is left out: `watchmanFinding` reports it from the same 2 GiB. */
export function memoryCulpritFindings(culprits: readonly MemoryCulprit[] | null): Finding[] {
  return (culprits ?? [])
    .filter((culprit) => culprit.name !== 'Watchman')
    .map((culprit) => ({
      code: 'memory-culprit',
      level: 'cost',
      title: `${culprit.name} uses ${formatBytes(culprit.bytes)} of memory`,
      detail: memoryCulpritAdvice([culprit])!,
      fix: culprit.command
        ? `Run \`${culprit.command}\`. ${culprit.note}`
        : 'Stim knows no safe restart for this process. Ask before quitting it.',
    }));
}
