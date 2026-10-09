const childProcess = require('node:child_process');
const { appendFileSync, mkdirSync } = require('node:fs');
const { basename, join } = require('node:path');
const { syncBuiltinESMExports } = require('node:module');
const { Worker } = require('node:worker_threads');

if (process.platform !== 'win32' || process.env.CI !== '1' || !process.env.STIM_E2E_STOP_DIAGNOSTICS) {
  throw new Error('Stop inventory diagnostics require opted-in Windows CI');
}
const directory = process.env.STIM_E2E_STOP_DIAGNOSTICS;
mkdirSync(directory, { recursive: true });
const file = join(directory, `${process.pid}.ndjson`);
let evidenceFailed = false;
const record = (event, detail = {}) => {
  try {
    appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), event, ...detail })}\n`);
  } catch {
    evidenceFailed = true;
    process.stderr.write('Stop inventory diagnostic write failed\n');
  }
};
const state = new Int32Array(new SharedArrayBuffer(12));
const worker = new Worker(join(__dirname, 'adb-stop-sampler.mjs'), {
  execArgv: [],
  workerData: { file, state: state.buffer, rootPid: process.pid },
});
worker.on('error', () => {
  evidenceFailed = true;
  record('observer.worker-error');
});
worker.unref();
record('observer.start', { rootPid: process.pid });
process.on('exit', (code) => {
  Atomics.store(state, 1, 1);
  Atomics.notify(state, 1);
  Atomics.wait(state, 2, 0, 7000);
  const settled = Atomics.load(state, 2);
  record('observer.settlement', { state: settled, code });
  if (code === 0 && (settled !== 1 || evidenceFailed)) process.exitCode = 1;
});
Atomics.wait(state, 0, 0, 7000);
if (Atomics.load(state, 0) !== 1 || evidenceFailed)
  throw new Error('Stop observer could not establish its root identity');
const original = childProcess.spawnSync;
let sequence = 0;
childProcess.spawnSync = function (program, args, options) {
  const name = basename(program)
    .toLowerCase()
    .replace(/\.exe$/, '');
  const inventory =
    args?.length === 1 &&
    ((name === 'adb' && args[0] === 'devices') || (name === 'emulator' && args[0] === '-list-avds'));
  if (!inventory) return original.call(this, program, args, options);
  const id = ++sequence;
  record('inventory.start', {
    id,
    program: name,
    operation: args[0],
    timeout: options?.timeout,
    killSignal: options?.killSignal,
  });
  try {
    const result = original.call(this, program, args, options);
    record('inventory.return', {
      id,
      pid: result.pid,
      status: result.status,
      signal: result.signal,
      error: result.error ? { code: result.error.code } : null,
      stdout: String(result.stdout ?? '').slice(-16384),
      stderr: String(result.stderr ?? '').slice(-16384),
    });
    return result;
  } catch (error) {
    record('inventory.throw', { id, code: error.code, status: error.status, signal: error.signal });
    throw error;
  }
};
syncBuiltinESMExports();
