import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getExecutor } from '../../../packages/stim-cli/src/exec.ts';
import { upsertProject } from '../../../packages/stim-cli/src/config.ts';
import { ensureOwnedDevice } from '../../../packages/stim-cli/src/engine/device.ts';
import { installAndroidApp } from '../../../packages/stim-cli/src/engine/app-install.ts';
import { apkPackage, dumpApkManifest } from '../../../packages/stim-cli/src/commands/android.ts';
import { reclaimProject } from '../../../packages/stim-cli/src/reclaim.ts';
import { readParked } from '../../../packages/stim-cli/src/sim-pool.ts';
import { listAvds, resetAdoptedAvd } from '../../../packages/stim-cli/src/sim/android.ts';
import { teardownParkedAvd } from '../../../packages/stim-cli/src/teardown.ts';
import { collectParkedAvds, deleteParkedAvds } from '../../../packages/stim-cli/src/commands/gc/devices.ts';

if (process.argv[2] === '--device-worker') {
  const projectPath = process.argv[3];
  const device = await ensureOwnedDevice({
    platform: 'android',
    projectPath,
    label: process.argv[4],
    settings: {},
    logFile: join(projectPath, 'emulator.log'),
    out: (line) => process.stderr.write(`${line}\n`),
  });
  console.log(JSON.stringify(device));
  process.exit(0);
}

const apkPath = process.argv[2] && resolve(process.argv[2]);
assert(apkPath, 'Usage: node --experimental-strip-types test/e2e/native/run-android-pool-e2e.mjs <debug.apk>');
const work = realpathSync(mkdtempSync(join(tmpdir(), 'stim-android-pool-e2e-')));
process.env.STIM_HOME = join(work, 'home');
process.env.STIM_POOL_ANDROID_PARKED_MAX = '1';
const manifest = dumpApkManifest(apkPath);
const packageName = apkPackage(manifest);
const permission = ['android.permission.ACCESS_COARSE_LOCATION', 'android.permission.CAMERA'].find((name) =>
  manifest?.includes(name),
);
assert(packageName, 'The APK must expose its applicationId');
const exec = getExecutor();
const roots = [];
const owned = new Set();
const timings = [];
const out = (line) => process.stderr.write(`${line}\n`);
out(`Evidence: ${work}`);

async function deviceFor(index) {
  const projectPath = join(work, `project-${index}`);
  mkdirSync(projectPath);
  roots.push(projectPath);
  upsertProject(projectPath, { androidPackage: packageName });
  const started = performance.now();
  out(`Preparing emulator for workspace ${index}`);
  const device = JSON.parse(
    exec.runFile(
      process.execPath,
      [
        '--experimental-strip-types',
        fileURLToPath(import.meta.url),
        '--device-worker',
        projectPath,
        `pool-e2e-${process.pid}-${index}`,
      ],
      { timeoutMs: 180000 },
    ),
  );
  assert(device.avdName);
  owned.add(device.avdName);
  const ready = performance.now();
  const serial = `emulator-${device.consolePort}`;
  if (device.adopted) resetAdoptedAvd(device.avdName, serial, packageName);
  const cleaned = performance.now();
  const installed = installAndroidApp({ serial, apkPath, packageName });
  assert(installed.ok, JSON.stringify(installed));
  const finished = performance.now();
  timings.push({
    name: device.avdName,
    systemImage: device.systemImage,
    adopted: Boolean(device.adopted),
    prepareMs: Math.round(ready - started),
    cleanupMs: Math.round(cleaned - ready),
    installMs: Math.round(finished - cleaned),
    totalMs: Math.round(finished - started),
    skipped: Boolean(installed.skipped),
  });
  out(JSON.stringify(timings.at(-1)));
  return { projectPath, device, serial };
}

try {
  const first = await deviceFor(1);
  assert.equal(first.device.adopted, undefined);
  exec.runFile('adb', ['-s', first.serial, 'shell', 'run-as', packageName, 'mkdir', '-p', 'files']);
  exec.runFile('adb', ['-s', first.serial, 'shell', 'run-as', packageName, 'touch', 'files/stim-pool-proof']);
  exec.runFile('adb', ['-s', first.serial, 'shell', 'run-as', packageName, 'test', '-e', 'files/stim-pool-proof']);
  if (permission) {
    exec.runFile('adb', ['-s', first.serial, 'shell', 'pm', 'grant', packageName, permission]);
    const permissions = exec.runFile('adb', ['-s', first.serial, 'shell', 'dumpsys', 'package', packageName]);
    assert(permissions.includes(`${permission}: granted=true`));
  }
  const removed = await reclaimProject(first.projectPath, { deleteOwnedDevices: true, parkOwnedDevices: true });
  assert.equal(removed.parkedDevices[0]?.name, first.device.avdName, JSON.stringify(removed));
  assert.equal(readParked('android').length, 1);
  const second = await deviceFor(2);
  assert.equal(second.device.avdName, first.device.avdName);
  assert.equal(second.device.adopted, true);
  assert.equal(timings.at(-1).skipped, true);
  exec.runFile('adb', [
    '-s',
    second.serial,
    'shell',
    'run-as',
    packageName,
    'test',
    '!',
    '-e',
    'files/stim-pool-proof',
  ]);
  if (permission) {
    const permissions = exec.runFile('adb', ['-s', second.serial, 'shell', 'dumpsys', 'package', packageName]);
    assert(!permissions.includes(`${permission}: granted=true`), 'Adoption must clear the runtime permission grant');
  }
  const parkedAgain = await reclaimProject(second.projectPath, { deleteOwnedDevices: true, parkOwnedDevices: true });
  assert.equal(parkedAgain.parkedDevices[0]?.name, first.device.avdName, JSON.stringify(parkedAgain));
  const report = collectParkedAvds({});
  assert.equal(report.length, 1);
  assert.equal(report[0].listed, true);
  assert.equal(deleteParkedAvds(report), 0);
  assert.equal(readParked('android').length, 0);
  assert(!listAvds().includes(first.device.avdName));
  writeFileSync(
    join(work, 'result.json'),
    JSON.stringify(
      { packageName, timings, appDataCleared: true, permissionReset: permission ?? null, gcDeleted: true },
      null,
      2,
    ),
  );
  out('PASS Android park/adopt, app-data cleanup, retained APK and GC');
} finally {
  for (const projectPath of roots) {
    const result = await reclaimProject(projectPath, { deleteOwnedDevices: true });
    if (result.failedDevices.length) out(JSON.stringify(result.failedDevices));
  }
  for (const parked of readParked('android')) {
    const result = teardownParkedAvd(parked.name);
    assert.equal(result.status, 'torn-down', JSON.stringify(result));
  }
  const remaining = listAvds().filter((name) => owned.has(name));
  assert.deepEqual(remaining, [], `Run-owned AVDs remain: ${remaining.join(', ')}`);
}
