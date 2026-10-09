const childProcess = require('node:child_process');
const { appendFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');
const { syncBuiltinESMExports } = require('node:module');
const { Worker } = require('node:worker_threads');

if (process.platform !== 'win32' || process.env.CI !== '1' || !process.env.STIM_E2E_AVD_DIAGNOSTICS) {
  throw new Error('AVD deletion diagnostics require the opted-in Windows CI loop');
}
const directory = process.env.STIM_E2E_AVD_DIAGNOSTICS;
mkdirSync(directory, { recursive: true });
const original = childProcess.execSync;
let sequence = 0;
childProcess.execSync = function (command, options) {
  const match = /(?:^|[\\/])avdmanager\.bat"? delete avd -n "(stim-[\w.-]+)"$/.exec(command);
  if (!match) return original.call(this, command, options);
  const file = join(directory, `${process.pid}-${++sequence}.ndjson`);
  const record = (event, detail = {}) =>
    appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), event, ...detail })}\n`);
  const state = new Int32Array(new SharedArrayBuffer(12));
  const worker = new Worker(join(__dirname, 'avd-delete-sampler.mjs'), {
    execArgv: [],
    workerData: {
      file,
      state: state.buffer,
      rootPid: process.pid,
      avd: match[1],
      avdRoot: options?.env?.ANDROID_AVD_HOME ?? process.env.ANDROID_AVD_HOME ?? null,
    },
  });
  worker.on('error', (error) => record('observer.worker-error', { message: error.message }));
  record('exec.start', { pid: process.pid, avd: match[1], timeout: options?.timeout, killSignal: options?.killSignal });
  Atomics.wait(state, 0, 0, 7000);
  try {
    if (Atomics.load(state, 0) !== 1) throw new Error('AVD diagnostic observer did not establish its root identity');
    const result = original.call(this, command, options);
    record('exec.return', { stdout: String(result).slice(-16384) });
    return result;
  } catch (error) {
    record('exec.throw', {
      code: error.code,
      status: error.status,
      signal: error.signal,
      childPid: error.pid,
      stdout: String(error.stdout ?? '').slice(-16384),
      stderr: String(error.stderr ?? '').slice(-16384),
    });
    throw error;
  } finally {
    Atomics.store(state, 1, 1);
    Atomics.notify(state, 1);
    Atomics.wait(state, 2, 0, 7000);
    record('observer.settlement', { state: Atomics.load(state, 2) });
  }
};
syncBuiltinESMExports();
