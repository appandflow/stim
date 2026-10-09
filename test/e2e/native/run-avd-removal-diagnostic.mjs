import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getExecutor, setExecutor } from '../../../packages/stim-cli/src/exec.ts';
import { getProject, upsertProject } from '../../../packages/stim-cli/src/workspace/config.ts';
import { ensureOwnedDevice } from '../../../packages/stim-cli/src/engine/device.ts';
import { stopWorkspaceNow } from '../../../packages/stim-cli/src/commands/stop.ts';
import { removeWorktreeTarget } from '../../../packages/stim-cli/src/commands/worktree.ts';
import { readCreatedDevices } from '../../../packages/stim-cli/src/devices/created-devices.ts';
import {
  avdNameAbsent,
  avdStorageRoots,
  listAdbDevices,
  listAvds,
  ownedAvdDirectory,
} from '../../../packages/stim-cli/src/devices/android.ts';

assert.equal(process.platform, 'win32');
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'This diagnostic runs only on the hosted Windows runner');
const evidence = resolve('D:/e/windows-avd-diagnostic');
assert(!existsSync(evidence), 'Retain prior evidence instead of overwriting an attempt');
mkdirSync(evidence, { recursive: true });
process.env.STIM_HOME = join(evidence, 'home');
process.env.STIM_DEBUG = '1';
process.env.STIM_POOL_ANDROID_PARKED_MAX = '0';
process.env.STIM_POOL_IOS_PARKED_MAX = '0';
const original = getExecutor();
const record = (event, data = {}) => {
  const row = { at: new Date().toISOString(), event, ...data };
  appendFileSync(join(evidence, 'diagnostic.ndjson'), `${JSON.stringify(row)}\n`);
  console.error(JSON.stringify(row));
};
const bounded = (value) => {
  const text = String(value ?? '');
  return { text: text.slice(-16384), length: text.length, truncated: text.length > 16384 };
};
function directoryState(path) {
  if (!path) return { unknown: 'No owned content directory resolved' };
  try {
    const entries = readdirSync(path, { withFileTypes: true });
    return {
      path,
      count: entries.length,
      entries: entries.slice(0, 100).map((entry) => ({ name: entry.name, directory: entry.isDirectory() })),
    };
  } catch (error) {
    return { path, ...(error.code === 'ENOENT' ? { absent: true } : { unknown: error.code ?? error.name }) };
  }
}
function sdkCommand(command, run, opts) {
  const started = performance.now();
  record('sdk.start', { command, timeoutMs: opts?.timeoutMs });
  try {
    const stdout = run();
    record('sdk.end', { command, ms: Math.round(performance.now() - started), ok: true, stdout: bounded(stdout) });
    return stdout;
  } catch (error) {
    record('sdk.end', {
      command,
      ms: Math.round(performance.now() - started),
      ok: false,
      code: error.code,
      status: error.status,
      signal: error.signal,
      stdout: bounded(error.stdout),
      stderr: bounded(error.stderr),
    });
    throw error;
  }
}
setExecutor({
  ...original,
  run(command, opts) {
    const run = () => original.run(command, opts);
    return command.includes('avdmanager') ? sdkCommand(command, run, opts) : run();
  },
  runFile(file, args, opts) {
    const run = () => original.runFile(file, args, opts);
    return file.includes('avdmanager') ? sdkCommand([file, ...(args ?? [])].join(' '), run, opts) : run();
  },
});
const exec = getExecutor();
const cli = resolve('packages/stim-cli/dist/cli.mjs');
for (const key of ['iosSimulatorApp', 'androidEmulatorApp'])
  exec.runFile(process.execPath, [cli, 'settings', 'set', key, 'stim-desktop'], { timeoutMs: 30000 });
const sdk = process.env.ANDROID_HOME;
assert(sdk);
const packages = [
  ['emulator', '37.1.11'],
  ['platform-tools', '37.0.1'],
  ['system-images/android-34/google_apis/x86_64', '14'],
  ['cmdline-tools/latest', null],
];
for (const [name, expected] of packages) {
  const text = readFileSync(join(sdk, name, 'source.properties'), 'utf8');
  writeFileSync(join(evidence, `${name.replaceAll('/', '-')}-source.properties`), text);
  const revision = /^Pkg.Revision\s*=\s*(.+)$/m.exec(text)?.[1]?.trim();
  record('sdk.revision', { name, revision });
  if (expected)
    assert.equal(revision, expected, `SDK changed for ${name}; do not claim comparison to the prior attempt`);
}
const javaVersion = exec.runFile(join(process.env.JAVA_HOME, 'bin/java.exe'), ['--version'], { timeoutMs: 10000 });
writeFileSync(join(evidence, 'java-version.txt'), javaVersion);
assert.match(javaVersion, /17\.0\.20/);
assert.match(javaVersion, /Temurin-17\.0\.20\.1\+1\b/);
record('source', { sha: exec.runFile('git', ['rev-parse', 'HEAD'], { timeoutMs: 10000 }) });
const originalAvds = listAvds({ timeoutMs: 10000 }).toSorted();
const originalAdb = listAdbDevices({ timeoutMs: 10000 });
record('before', { avds: originalAvds, adb: originalAdb, ledger: [...readCreatedDevices().android] });
assert.equal(readCreatedDevices().android.size, 0);
const seed = join(evidence, 'seed');
const source = join(evidence, 'source');
const project = join(evidence, 'workspace');
mkdirSync(seed);
writeFileSync(join(seed, 'package.json'), JSON.stringify({ name: 'stim-avd-removal-diagnostic', private: true }));
exec.runFile('git', ['init', seed], { timeoutMs: 10000 });
exec.runFile('git', ['-C', seed, 'add', 'package.json'], { timeoutMs: 10000 });
exec.runFile(
  'git',
  ['-C', seed, '-c', 'user.name=Stim CI', '-c', 'user.email=ci@example.invalid', 'commit', '-m', 'fixture'],
  { timeoutMs: 10000 },
);
exec.runFile('git', ['clone', seed, source], { timeoutMs: 10000 });
exec.runFile('git', ['-C', source, 'worktree', 'add', '--detach', project, 'HEAD'], { timeoutMs: 10000 });
const root = realpathSync.native(project);
upsertProject(root, {});
let device;
let avdDirectory;
let stopAttempted = false;
let removed = false;
try {
  record('create-boot.start');
  device = await ensureOwnedDevice({
    platform: 'android',
    projectPath: root,
    label: `avd-removal-${process.pid}`,
    settings: { android: { systemImage: 'system-images;android-34;google_apis;x86_64' } },
    logFile: join(evidence, 'emulator.log'),
    out: (line) => console.error(line),
  });
  assert(device.owned && device.avdName && device.consolePort && !device.bootPending);
  assert(readCreatedDevices().android.has(device.avdName));
  assert(!originalAvds.includes(device.avdName));
  avdDirectory = ownedAvdDirectory(device.avdName);
  assert(avdDirectory);
  record('create-boot.end', { device, project: getProject(root), directory: directoryState(avdDirectory) });
  stopAttempted = true;
  record('stop.start');
  const stopped = await stopWorkspaceNow({ root });
  record('stop.end', { result: stopped });
  assert.equal(stopped.ok, true);
  const beforeRemove = listAdbDevices({ timeoutMs: 10000 });
  record('remove.start', {
    device,
    adb: beforeRemove,
    ledger: [...readCreatedDevices().android],
    directory: directoryState(avdDirectory),
  });
  assert(
    ![...beforeRemove.emulators, ...beforeRemove.unhealthy].some((entry) => entry.consolePort === device.consolePort),
  );
  removed = await removeWorktreeTarget(root);
  record('remove.end', { removed, project: getProject(root), ledger: [...readCreatedDevices().android] });
  assert(removed, 'Public worktree removal refused; retain the registry, device and worktree evidence');
  assert(!existsSync(root));
  assert.equal(getProject(root), null);
  assert(!readCreatedDevices().android.has(device.avdName));
  assert(avdNameAbsent(device.avdName, avdStorageRoots()));
  assert.deepEqual(listAvds({ timeoutMs: 10000 }).toSorted(), originalAvds);
  const afterRemove = listAdbDevices({ timeoutMs: 10000 });
  record('after', { adb: afterRemove });
  assert(
    ![...afterRemove.emulators, ...afterRemove.unhealthy].some((entry) => entry.consolePort === device.consolePort),
  );
  record('passed', {
    scope: 'One owned AVD create, boot, stop and removal; no app or strict multi-slot lifecycle acceptance',
  });
} catch (error) {
  record('failed', { message: String(error.message), code: error.code, removed });
  if (!stopAttempted && getProject(root)?.platforms?.android) {
    record('failure-stop.start');
    try {
      const stopped = await stopWorkspaceNow({ root });
      record('failure-stop.end', { result: stopped });
    } catch (cleanupError) {
      record('failure-stop.failed', { message: String(cleanupError.message) });
    }
  }
  throw error;
} finally {
  record('retained-state', {
    project: getProject(root),
    ledger: [...readCreatedDevices().android],
    removed,
    directory: directoryState(avdDirectory),
  });
}
