import { readdirSync, readFileSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import { C_LOCALE, run } from './shell.mjs';

export const SAMPLE_COLUMNS = [
  'ts',
  'epoch',
  'took_ms',
  'stage',
  'load1',
  'pressure',
  'page_bytes',
  'vm_free_pages',
  'vm_active_pages',
  'vm_wired_pages',
  'vm_compressed_pages',
  'vm_inactive_pages',
  'vm_speculative_pages',
  'vm_purgeable_pages',
  'swap_used_mb',
  'disk_free_mb',
  'home_free_mb',
  'work_free_mb',
  'booted_total',
  'booted_ours',
  'booting_ours',
  'n_supervisor',
  'rss_supervisor_mb',
  'n_collector',
  'rss_collector_mb',
  'n_daemon',
  'rss_daemon_mb',
  'n_metro',
  'rss_metro_mb',
  'n_xcodebuild',
  'rss_xcodebuild_mb',
];

export const PROCESS_KINDS = ['supervisor', 'collector', 'daemon', 'metro', 'xcodebuild'];

export function parseVmStat(text) {
  const pageBytes = Number(/page size of (\d+) bytes/.exec(text)?.[1] ?? 0) || null;
  const pages = (label) => {
    const match = new RegExp(`^${label}:\\s+(\\d+)`, 'm').exec(text);
    return match ? Number(match[1]) : null;
  };
  return {
    pageBytes,
    free: pages('Pages free'),
    active: pages('Pages active'),
    wired: pages('Pages wired down'),
    compressed: pages('Pages occupied by compressor'),
    inactive: pages('Pages inactive'),
    speculative: pages('Pages speculative'),
    purgeable: pages('Pages purgeable'),
  };
}

export function parseSwapUsedMb(text) {
  const match = /used = ([\d.]+)([MG])/.exec(text);
  if (!match) return null;
  return Math.round(Number(match[1]) * (match[2] === 'G' ? 1024 : 1));
}

export function parseLoad1(text) {
  const match = /[{\s]*([\d.]+)/.exec(text);
  return match ? Number(match[1]) : null;
}

export function parseSimctlDevices(json) {
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  return Object.values(parsed?.devices ?? {})
    .flat()
    .map((device) => ({ udid: device.udid, name: device.name, state: device.state }));
}

const LSTART = String.raw`\w{3} \w{3}\s+\d+ [\d:]{8} \d{4}`;
const PS_LINE = new RegExp(String.raw`^\s*(\d+)\s+(\d+)\s+(\d+)\s+(?:(${LSTART})\s+)?(.*)$`);

export function parsePs(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const match = PS_LINE.exec(line);
    if (match) {
      out.push({
        pid: Number(match[1]),
        ppid: Number(match[2]),
        rssMb: Number(match[3]) / 1024,
        lstart: match[4] ?? null,
        cmd: match[5],
      });
    }
  }
  return out;
}

function kindOf(cmd) {
  if (cmd.startsWith('stim-supervisor')) return 'supervisor';
  if (cmd.startsWith('stim-collector')) return 'collector';
  if (/stim-daemon/.test(cmd)) return 'daemon';
  if (/(^|\/)xcodebuild(\s|$)/.test(cmd)) return 'xcodebuild';
  if (/(^|\/)node(\s|$)/.test(cmd) && /expo\/bin\/cli|@expo\/cli|\bexpo start\b|metro/.test(cmd)) return 'metro';
  return null;
}

function looksOurs(cmd, { home, worktreePrefix }) {
  return /^stim-(supervisor|collector|daemon)/.test(cmd) || cmd.includes(home) || cmd.includes(worktreePrefix);
}

// The supervisor retitles itself to a bare `stim-supervisor` (packages/stim-cli/src/supervisor/run.ts), so no command
// line names the home: a recorded pid is the run's only while its start time is the one seen when it was first recorded.
export function noteRecorded(recordedAt, pids, now) {
  for (const pid of pids) if (!recordedAt.has(pid)) recordedAt.set(pid, now);
}

export function recordIdentities(identities, rows, recordedAt, scope, sinceMs) {
  for (const row of rows) {
    if (!recordedAt.has(row.pid) || identities.has(row.pid) || !row.lstart) continue;
    const started = Date.parse(row.lstart);
    if (started >= sinceMs - 2000 && started <= recordedAt.get(row.pid) + 1000 && looksOurs(row.cmd, scope)) {
      identities.set(row.pid, row.lstart);
    }
  }
}

export function provenOurs(rows, identities, scope) {
  return rows.filter((row) => identities.get(row.pid) === row.lstart && looksOurs(row.cmd, scope));
}

export function classifyStimProcesses(procs, { identities, home, worktreePrefix }) {
  const children = new Map();
  for (const p of procs) {
    if (!children.has(p.ppid)) children.set(p.ppid, []);
    children.get(p.ppid).push(p.pid);
  }
  const owned = new Set();
  const visit = (pid) => {
    if (owned.has(pid)) return;
    owned.add(pid);
    for (const child of children.get(pid) ?? []) visit(child);
  };
  for (const row of provenOurs(procs, identities, { home, worktreePrefix })) visit(row.pid);
  const totals = Object.fromEntries(PROCESS_KINDS.map((kind) => [kind, { n: 0, rssMb: 0 }]));
  for (const p of procs) {
    const kind = kindOf(p.cmd);
    if (!kind) continue;
    const named = p.cmd.includes(home) || p.cmd.includes(worktreePrefix);
    if (!(owned.has(p.pid) || (named && kind !== 'supervisor' && kind !== 'collector'))) continue;
    totals[kind].n += 1;
    totals[kind].rssMb += p.rssMb;
  }
  return totals;
}

const liveProcesses = (state) => ({ supervisor: state?.supervisor, collectors: state?.collectors });

function pidsIn(value, found) {
  if (Array.isArray(value)) for (const item of value) pidsIn(item, found);
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (key === 'pid' && Number.isInteger(item) && item > 1) found.add(item);
      else pidsIn(item, found);
    }
  }
}

export function recordedPids(home) {
  const found = new Set();
  const read = (file, pick = (record) => record) => {
    try {
      pidsIn(pick(JSON.parse(readFileSync(file, 'utf8'))), found);
    } catch {}
  };
  try {
    for (const entry of readdirSync(join(home, 'workspaces'))) {
      read(join(home, 'workspaces', entry, 'state.json'), liveProcesses);
    }
  } catch {}
  try {
    const dir = join(home, 'daemon');
    for (const entry of readdirSync(dir, { recursive: true })) read(join(dir, String(entry)));
  } catch {}
  return found;
}

export function ledgerUdids(home) {
  try {
    const text = readFileSync(join(home, 'created-devices.json'), 'utf8');
    return new Set(text.match(/[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}/g) ?? []);
  } catch {
    return new Set();
  }
}

function freeDiskMb(path) {
  try {
    const stat = statfsSync(path);
    return Math.round((stat.bavail * stat.bsize) / 1048576);
  } catch {
    return null;
  }
}

export async function readSimulators(timeoutMs = 20_000) {
  const result = await run('xcrun', ['simctl', 'list', 'devices', '-j'], { timeoutMs });
  return result.code === 0 ? parseSimctlDevices(result.stdout) : null;
}

export async function readMachine() {
  const [ram, cores, os, model] = await Promise.all([
    run('sysctl', ['-n', 'hw.memsize']),
    run('sysctl', ['-n', 'hw.ncpu']),
    run('sw_vers', ['-productVersion']),
    run('sysctl', ['-n', 'hw.model']),
  ]);
  return {
    ramBytes: Number(ram.stdout.trim()) || null,
    cores: Number(cores.stdout.trim()) || null,
    macos: os.stdout.trim() || null,
    model: model.stdout.trim() || null,
  };
}

export async function sampleHost({ home, worktreePrefix, stage, volumes, identities, recordedAt, sinceMs }) {
  const startedMs = Date.now();
  const [load, pressure, vm, swap, ps, sims] = await Promise.all([
    run('sysctl', ['-n', 'vm.loadavg'], { timeoutMs: 10_000 }),
    run('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], { timeoutMs: 10_000 }),
    run('vm_stat', [], { timeoutMs: 10_000 }),
    run('sysctl', ['-n', 'vm.swapusage'], { timeoutMs: 10_000 }),
    run('ps', ['-axww', '-o', 'pid=,ppid=,rss=,lstart=,command='], { timeoutMs: 15_000, env: C_LOCALE() }),
    readSimulators(),
  ]);
  const now = new Date();
  const memory = parseVmStat(vm.stdout);
  const ours = ledgerUdids(home);
  const mine = sims?.filter((sim) => ours.has(sim.udid)) ?? [];
  const rows = parsePs(ps.stdout);
  const scope = { home, worktreePrefix };
  noteRecorded(recordedAt, recordedPids(home), Date.now());
  recordIdentities(identities, rows, recordedAt, scope, sinceMs);
  const procs = classifyStimProcesses(rows, { identities, ...scope });
  const row = {
    ts: now.toISOString(),
    epoch: Math.round(now.getTime() / 1000),
    took_ms: now.getTime() - startedMs,
    stage,
    load1: parseLoad1(load.stdout),
    pressure: Number(pressure.stdout.trim()) || null,
    page_bytes: memory.pageBytes,
    vm_free_pages: memory.free,
    vm_active_pages: memory.active,
    vm_wired_pages: memory.wired,
    vm_compressed_pages: memory.compressed,
    vm_inactive_pages: memory.inactive,
    vm_speculative_pages: memory.speculative,
    vm_purgeable_pages: memory.purgeable,
    swap_used_mb: parseSwapUsedMb(swap.stdout),
    disk_free_mb: freeDiskMb(volumes.simulators),
    home_free_mb: freeDiskMb(volumes.home),
    work_free_mb: freeDiskMb(volumes.work),
    booted_total: sims ? sims.filter((sim) => sim.state === 'Booted').length : null,
    booted_ours: sims ? mine.filter((sim) => sim.state === 'Booted').length : null,
    booting_ours: sims ? mine.filter((sim) => sim.state === 'Booting').length : null,
  };
  for (const kind of PROCESS_KINDS) {
    row[`n_${kind}`] = procs[kind].n;
    row[`rss_${kind}_mb`] = Math.round(procs[kind].rssMb);
  }
  return row;
}

export const csvLine = (row) => SAMPLE_COLUMNS.map((column) => row[column] ?? '').join(',');

export function parseCsv(text) {
  const [head, ...lines] = text.split('\n').filter(Boolean);
  const columns = head.split(',');
  return lines.map((line) => {
    const cells = line.split(',');
    const row = {};
    columns.forEach((column, index) => {
      const cell = cells[index] ?? '';
      row[column] = cell !== '' && column !== 'ts' && column !== 'stage' ? Number(cell) : cell === '' ? null : cell;
    });
    return row;
  });
}
