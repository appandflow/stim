import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

assert(process.platform === 'win32' && process.env.CI === '1', 'Windows CI only');
const here = dirname(fileURLToPath(import.meta.url));
const root = process.env.STIM_STOP_QUALIFICATION;
assert(root, 'qualification output directory required');
mkdirSync(root, { recursive: true });
const save = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const [, , role, selectedMode, selectedDirectory] = process.argv;
const originalFields = (result) => ({
  pid: result.pid,
  status: result.status,
  signal: result.signal,
  error: result.error ? { code: result.error.code } : null,
  stdout: String(result.stdout ?? ''),
  stderr: String(result.stderr ?? ''),
});
if (role === 'tools') {
  const { getExecutor } = await import('../../../packages/stim-cli/src/exec.ts');
  const { listAvds, listAdbDevices, androidToolPath } =
    await import('../../../packages/stim-cli/src/devices/android.ts');
  const options = { timeoutMs: 15000, killSignal: 'SIGKILL' };
  const adb = getExecutor().runFile(androidToolPath('adb'), ['version'], options);
  const emulator = getExecutor().runFile(androidToolPath('emulator'), ['-version'], options);
  save(join(selectedDirectory, 'versions.json'), { adb, emulator });
  assert.match(adb, /Version 37\.0\.1-/);
  assert.match(emulator, /Android emulator version 37\.1\.11\b/);
  const inventory = { avds: listAvds({ timeoutMs: 5000 }), devices: listAdbDevices({ timeoutMs: 5000 }) };
  save(join(selectedDirectory, 'inventory.json'), inventory);
  assert.deepEqual(inventory.avds, []);
  assert.deepEqual(inventory.devices, { emulators: [], physical: [], unhealthy: [] });
} else if (role === 'worker') {
  const result = spawnSync(join(selectedDirectory, 'adb.exe'), ['devices'], {
    env: {
      ...process.env,
      NODE_OPTIONS: `--require "${join(root, 'finite-client.cjs').replaceAll('\\', '/')}"`,
      STIM_STOP_MODE: selectedMode,
    },
    timeout: selectedMode === 'timeout' ? 5000 : 20000,
    killSignal: 'SIGKILL',
    encoding: 'utf8',
  });
  save(join(selectedDirectory, 'result.json'), originalFields(result));
} else {
  assert.equal(role, undefined);
  save(join(root, 'source.json'), {
    commit: process.env.GITHUB_SHA,
    node: process.version,
    files: Object.fromEntries(
      ['adb-stop-preload.cjs', 'adb-stop-sampler.mjs', 'qualify-stop-observer.mjs'].map((name) => [
        name,
        createHash('sha256')
          .update(readFileSync(join(here, name)))
          .digest('hex'),
      ]),
    ),
  });
  writeFileSync(
    join(root, 'finite-client.cjs'),
    `
const { writeFileSync, writeSync } = require('node:fs');
writeFileSync(process.env.STIM_STOP_CHILD_PID, String(process.pid));
writeSync(1, 'inventory-out\\n');
writeSync(2, 'inventory-err\\n');
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, process.env.STIM_STOP_MODE === 'timeout' ? 12000 : 6000);
process.exit(process.env.STIM_STOP_MODE === 'failure' ? 23 : 0);
`,
  );
  const scenarios = [];
  for (const mode of ['success', 'failure', 'timeout']) {
    const directory = join(root, mode);
    mkdirSync(directory);
    copyFileSync(process.execPath, join(directory, 'adb.exe'));
    const result = spawnSync(
      process.execPath,
      ['--require', join(here, 'adb-stop-preload.cjs'), fileURLToPath(import.meta.url), 'worker', mode, directory],
      {
        env: {
          ...process.env,
          STIM_E2E_STOP_DIAGNOSTICS: directory,
          STIM_STOP_CHILD_PID: join(directory, 'child-pid.txt'),
        },
        timeout: 45000,
        killSignal: 'SIGKILL',
        encoding: 'utf8',
      },
    );
    save(join(directory, 'worker.json'), originalFields(result));
    assert.equal(result.status, 0, result.stderr);
    const value = JSON.parse(readFileSync(join(directory, 'result.json'), 'utf8'));
    const childPid = Number(readFileSync(join(directory, 'child-pid.txt'), 'utf8'));
    assert(Number.isSafeInteger(childPid) && childPid > 0);
    assert.equal(value.pid, childPid);
    assert.equal(value.stdout, 'inventory-out\n');
    assert.equal(value.stderr, 'inventory-err\n');
    assert.equal(value.error?.code ?? null, mode === 'timeout' ? 'ETIMEDOUT' : null);
    assert.equal(value.status, mode === 'timeout' ? null : mode === 'failure' ? 23 : 0);
    assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' });
    const records = settledRecords(directory);
    const starts = records.filter((entry) => entry.event === 'inventory.start');
    assert.equal(starts.length, 1, 'the actual ESM spawnSync call must be intercepted exactly once');
    assert.equal(starts[0].program, 'adb');
    assert.equal(starts[0].operation, 'devices');
    const returned = records.find((entry) => entry.event === 'inventory.return' && entry.id === starts[0].id);
    assert(returned);
    for (const field of ['pid', 'status', 'signal', 'error', 'stdout', 'stderr'])
      assert.deepEqual(returned[field], value[field]);
    const observations = records
      .filter((entry) => entry.event === 'sample')
      .flatMap((entry) => entry.processes)
      .filter((entry) => entry.pid === childPid);
    assert(
      observations.some((entry) => entry.observation === 'same' && entry.birth),
      'exact child must have a live birth observation',
    );
    const finalSample = records.findLast((entry) => entry.event === 'sample');
    assert.equal(finalSample?.final, true, 'the final query must begin after the CLI signals exit');
    assert(
      finalSample.processes.some((entry) => entry.pid === childPid && entry.observation === 'absent'),
      'exact child must be absent by final observer settlement',
    );
    scenarios.push({
      mode,
      childPid,
      queries: records.filter((entry) => entry.event === 'observer.query-start').length,
      records: records.length,
    });
  }
  const toolsDirectory = join(root, 'tools');
  mkdirSync(toolsDirectory);
  const toolsResult = spawnSync(
    process.execPath,
    ['--require', join(here, 'adb-stop-preload.cjs'), fileURLToPath(import.meta.url), 'tools', 'tools', toolsDirectory],
    {
      env: { ...process.env, STIM_E2E_STOP_DIAGNOSTICS: toolsDirectory },
      timeout: 90000,
      killSignal: 'SIGKILL',
      encoding: 'utf8',
    },
  );
  save(join(toolsDirectory, 'worker.json'), originalFields(toolsResult));
  assert.equal(toolsResult.status, 0, toolsResult.stderr);
  const toolsRecords = settledRecords(toolsDirectory);
  const starts = toolsRecords.filter((entry) => entry.event === 'inventory.start');
  assert.deepEqual(
    starts.map((entry) => [entry.program, entry.operation]),
    [
      ['emulator', '-list-avds'],
      ['adb', 'devices'],
    ],
  );
  for (const start of starts) {
    const result = toolsRecords.find((entry) => entry.event === 'inventory.return' && entry.id === start.id);
    assert(result);
    assert.equal(result.error, null);
    assert.equal(result.status, 0);
  }
  const inventory = JSON.parse(readFileSync(join(toolsDirectory, 'inventory.json'), 'utf8'));
  save(join(root, 'qualified.json'), { scenarios, inventory, complete: true });
}

function settledRecords(directory) {
  const logs = readdirSync(directory).filter((name) => name.endsWith('.ndjson'));
  assert.equal(logs.length, 1);
  const records = readFileSync(join(directory, logs[0]), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert(records.some((entry) => entry.event === 'observer.complete'));
  assert(!records.some((entry) => /failed|error/.test(entry.event)));
  assert.equal(records.find((entry) => entry.event === 'observer.settlement')?.state, 1);
  const queries = records.filter((entry) => entry.event === 'observer.query-start');
  assert(queries.length > 0);
  for (const query of queries) {
    assert.equal(
      records.filter((entry) => entry.event === 'observer.query-close' && entry.pid === query.pid).length,
      1,
    );
  }
  return records;
}
