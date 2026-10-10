import { execFile } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { workerData } from 'node:worker_threads';

const { file, rootPid } = workerData;
const state = new Int32Array(workerData.state);
const record = (event, detail = {}) =>
  appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), event, ...detail })}\n`);
const script = `
$ErrorActionPreference = 'Stop'
function Mark([string]$stage) { [Console]::Error.WriteLine('[stim-stop-query] ' + $stage + ' ' + [DateTime]::UtcNow.ToString('o')) }
Mark 'processes.start'
$rows = @(Get-CimInstance Win32_Process -OperationTimeoutSec 2 | ForEach-Object {
  [pscustomobject]@{ pid = [int]$_.ProcessId; parent = [int]$_.ParentProcessId; birth = $_.CreationDate.ToUniversalTime().ToString('o'); name = $_.Name; workingSet = [string]$_.WorkingSetSize; privateBytes = [string]$_.PrivatePageCount; kernelTime = [string]$_.KernelModeTime; userTime = [string]$_.UserModeTime; handles = $_.HandleCount; threads = $_.ThreadCount }
})
Mark 'processes.end'
[Console]::Out.WriteLine((@{ kind = 'processes'; rows = $rows } | ConvertTo-Json -Depth 4 -Compress))
Mark 'listeners.start'
$listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalPort -eq 5037 } | ForEach-Object { [pscustomobject]@{ address = $_.LocalAddress; port = $_.LocalPort; pid = [int]$_.OwningProcess } })
Mark 'listeners.end'
[Console]::Out.WriteLine((@{ kind = 'listeners'; listeners = $listeners } | ConvertTo-Json -Depth 4 -Compress))
Mark 'memory.start'
$memory = Get-CimInstance Win32_OperatingSystem -Property FreePhysicalMemory,TotalVisibleMemorySize,FreeVirtualMemory,TotalVirtualMemorySize -OperationTimeoutSec 2
Mark 'memory.end'
Mark 'serialization.start'
[Console]::Out.WriteLine((@{ kind = 'memory'; memory = @{ freePhysicalKiB = [string]$memory.FreePhysicalMemory; totalPhysicalKiB = [string]$memory.TotalVisibleMemorySize; freeVirtualKiB = [string]$memory.FreeVirtualMemory; totalVirtualKiB = [string]$memory.TotalVirtualMemorySize } } | ConvertTo-Json -Depth 4 -Compress))
Mark 'serialization.end'
`;
function snapshot() {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'pwsh.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        const stages = stderr.split(/\r?\n/).flatMap((line) => {
          const match =
            /^\[stim-stop-query\] (processes|listeners|memory|serialization)\.(start|end) ([0-9T:.Z-]+)$/.exec(line);
          return match ? [{ stage: `${match[1]}.${match[2]}`, at: match[3] }] : [];
        });
        record('observer.query-stages', { pid: child.pid, stages });
        try {
          const lines = stdout.split(/\r?\n/);
          if (error) lines.pop();
          const sections = lines.filter(Boolean).map((line) => JSON.parse(line));
          const rows = sections.find((section) => section.kind === 'processes')?.rows;
          const listeners = sections.find((section) => section.kind === 'listeners')?.listeners ?? null;
          const memory = sections.find((section) => section.kind === 'memory')?.memory ?? null;
          if (!Array.isArray(rows)) throw new Error('CIM process record unavailable');
          if (!error && (listeners === null || memory === null)) throw new Error('CIM snapshot incomplete');
          const query = {
            status: error ? 'partial' : 'complete',
            error: error ? { code: error.code ?? null, signal: error.signal ?? null } : null,
          };
          record('observer.query-result', { pid: child.pid, ...query });
          resolve({ rows, listeners, memory, query, observerPid: child.pid });
        } catch (parseError) {
          reject(Object.assign(parseError, { code: error?.code, signal: error?.signal }));
        }
      },
    );
    record('observer.query-start', { pid: child.pid });
    child.once('close', (code, signal) => record('observer.query-close', { pid: child.pid, code, signal }));
  });
}
const known = new Map();
function processes(result) {
  const rows = new Map(result.rows.map((row) => [row.pid, row]));
  const root = rows.get(rootPid);
  if (!root || root.name.toLowerCase() !== 'node.exe' || !root.birth) throw new Error('CIM root witness unavailable');
  if (!known.size) known.set(rootPid, root);
  if (known.get(rootPid).birth !== root.birth) throw new Error('CIM root identity changed');
  const ignored = new Set([result.observerPid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const row of rows.values()) {
      if (ignored.has(row.parent) && !ignored.has(row.pid)) {
        ignored.add(row.pid);
        changed = true;
      }
      const parent = known.get(row.parent);
      if (
        !ignored.has(row.pid) &&
        !known.has(row.pid) &&
        row.birth &&
        parent &&
        rows.get(parent.pid)?.birth === parent.birth &&
        row.birth >= parent.birth
      ) {
        known.set(row.pid, row);
        changed = true;
      }
    }
  }
  return [...known.values()].map((initial) =>
    Object.assign({}, initial, {
      observation:
        rows.get(initial.pid)?.birth === initial.birth ? 'same' : rows.has(initial.pid) ? 'reused' : 'absent',
      current: rows.get(initial.pid)?.birth === initial.birth ? rows.get(initial.pid) : undefined,
    }),
  );
}
const servers = new Map();
function adbObservations(result) {
  const rows = new Map(result.rows.map((row) => [row.pid, row]));
  for (const listener of result.listeners ?? []) {
    const process = rows.get(listener.pid);
    if (process && !servers.has(`${process.pid}:${process.birth}`))
      servers.set(`${process.pid}:${process.birth}`, process);
  }
  return {
    listeners:
      result.listeners?.map((listener) => Object.assign({}, listener, { process: rows.get(listener.pid) ?? null })) ??
      null,
    servers: [...servers.values()].map((initial) => ({
      initial,
      observation:
        rows.get(initial.pid)?.birth === initial.birth ? 'same' : rows.has(initial.pid) ? 'reused' : 'absent',
      current: rows.get(initial.pid)?.birth === initial.birth ? rows.get(initial.pid) : undefined,
    })),
    clients: result.rows
      .filter((row) => row.name.toLowerCase() === 'adb.exe')
      .map((row) => Object.assign({}, row, { parentIdentity: rows.get(row.parent) ?? null })),
  };
}
let failed = false;
try {
  const first = await snapshot();
  record('sample', {
    processes: processes(first),
    memory: first.memory,
    adb: adbObservations(first),
    query: first.query,
  });
  Atomics.store(state, 0, 1);
  Atomics.notify(state, 0);
  const deadline = Date.now() + 290000;
  let completed = false;
  while (Date.now() < deadline) {
    Atomics.wait(state, 1, 0, 1000);
    const final = Atomics.load(state, 1) === 1;
    const sample = await snapshot();
    record('sample', {
      processes: processes(sample),
      memory: sample.memory,
      adb: adbObservations(sample),
      query: sample.query,
      final,
    });
    if (final) {
      completed = true;
      break;
    }
  }
  if (!completed) throw new Error('Stop observer deadline reached before the final exit observation');
  record('observer.complete');
} catch (error) {
  failed = true;
  record('observer.failed', { message: error.message, code: error.code, signal: error.signal });
} finally {
  Atomics.store(state, 0, failed ? -1 : 1);
  Atomics.notify(state, 0);
  Atomics.store(state, 2, failed ? -1 : 1);
  Atomics.notify(state, 2);
}
