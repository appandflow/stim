import { execFile } from 'node:child_process';
import { appendFileSync, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { workerData } from 'node:worker_threads';

const { file, rootPid, avd, avdRoot } = workerData;
const state = new Int32Array(workerData.state);
const record = (event, detail = {}) =>
  appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), event, ...detail })}\n`);
const script = `
$ErrorActionPreference = 'Stop'
$rows = @(Get-CimInstance Win32_Process -OperationTimeoutSec 2 | ForEach-Object {
  [pscustomobject]@{ pid = [int]$_.ProcessId; parent = [int]$_.ParentProcessId; birth = $_.CreationDate.ToUniversalTime().ToString('o'); name = $_.Name; workingSet = [string]$_.WorkingSetSize; privateBytes = [string]$_.PrivatePageCount; kernelTime = [string]$_.KernelModeTime; userTime = [string]$_.UserModeTime; handles = $_.HandleCount; threads = $_.ThreadCount }
})
$memory = Get-CimInstance Win32_OperatingSystem -Property FreePhysicalMemory,TotalVisibleMemorySize,FreeVirtualMemory,TotalVirtualMemorySize -OperationTimeoutSec 2
@{ rows = $rows; memory = @{ freePhysicalKiB = [string]$memory.FreePhysicalMemory; totalPhysicalKiB = [string]$memory.TotalVisibleMemorySize; freeVirtualKiB = [string]$memory.FreeVirtualMemory; totalVirtualKiB = [string]$memory.TotalVirtualMemorySize } } | ConvertTo-Json -Depth 4 -Compress
`;
function snapshot() {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout) => {
        if (error) reject(Object.assign(new Error('CIM snapshot failed'), { code: error.code, signal: error.signal }));
        else {
          try {
            resolve({ ...JSON.parse(stdout), observerPid: child.pid });
          } catch (parseError) {
            reject(parseError);
          }
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
function pathMetadata(path) {
  try {
    const value = lstatSync(path);
    return {
      path,
      size: value.size,
      mtimeMs: value.mtimeMs,
      directory: value.isDirectory(),
      link: value.isSymbolicLink(),
    };
  } catch (error) {
    return { path, error: error.code };
  }
}
function avdMetadata() {
  if (!avdRoot) return { unavailable: 'SDK environment did not declare its AVD root' };
  const root = pathMetadata(avdRoot);
  const directory = pathMetadata(join(avdRoot, `${avd}.avd`));
  if (root.link || directory.link) return { root, directory, unavailable: 'linked path is not traversed' };
  let locks = [];
  if (directory.directory) {
    try {
      locks = readdirSync(directory.path)
        .filter((name) => /lock/i.test(name))
        .slice(0, 64)
        .map((name) => pathMetadata(join(directory.path, name)));
    } catch (error) {
      return { root, directory, error: error.code };
    }
  }
  return { root, directory, registration: pathMetadata(join(avdRoot, `${avd}.ini`)), locks };
}
let failed = false;
try {
  const first = await snapshot();
  record('sample', { processes: processes(first), memory: first.memory, avd: avdMetadata() });
  Atomics.store(state, 0, 1);
  Atomics.notify(state, 0);
  const deadline = Date.now() + 290000;
  while (!Atomics.load(state, 1) && Date.now() < deadline) {
    Atomics.wait(state, 1, 0, 1000);
    const sample = await snapshot();
    record('sample', { processes: processes(sample), memory: sample.memory, avd: avdMetadata() });
  }
  if (!Atomics.load(state, 1)) throw new Error('AVD observer deadline reached while SDK call remained pending');
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
