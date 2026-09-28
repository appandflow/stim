import assert from 'node:assert';
import { decideOffload } from '../offload/client.ts';
import { offloadFindings } from '../diagnostics/doctor-offload.ts';
import { RESULT_MARKER, parseWorkerOutput, type WorkerProbe } from '../offload/protocol.ts';

const ios = { xcode: 'Xcode 27.0 / Build version 27A266a', simulatorSdk: '27.0', cocoapods: '1.16.2' };
const toolchain = { ...ios, javaMajor: '17' };
const idleWorker: WorkerProbe = {
  root: '/Volumes/ExternalSSD/stim-offload',
  stimVersion: '1.14.0',
  stimBuildId: 'abc',
  ...ios,
  runtimes: ['iOS 27.0'],
  node: 'v26.7.0',
  arch: process.arch,
  cpus: 10,
  load1: 2,
  availableMemBytes: 6 * 1024 ** 3,
  diskFreeBytes: 20 * 1024 ** 3,
  xcodebuildRunning: 0,
  gradleRunning: 0,
  javaMajor: '17',
  androidSdk: '/sdk',
  ndk: ['27.1.12297006'],
  buildTools: ['37.0.0'],
  platforms: ['android-37.0'],
};
const base = {
  force: false,
  loadRatio: 1.5,
  local: { load1: 4, cpus: 14, activeBuilds: 0, maxBuilds: 3 },
  toolchain,
  localBuildId: 'abc',
  worker: idleWorker,
  workerError: null,
};

describe('decideOffload', () => {
  it('builds locally while this Mac has capacity', () => {
    assert.equal(decideOffload(base).offload, false);
  });

  it('offloads when the build slots are full or the load per core crosses the ratio', () => {
    assert.equal(decideOffload({ ...base, local: { ...base.local, activeBuilds: 3 } }).offload, true);
    assert.equal(decideOffload({ ...base, local: { ...base.local, load1: 700 } }).offload, true);
  });

  it('falls back to a local build when the worker is unreachable, busy, or on another toolchain', () => {
    const pressured = { ...base, force: true };
    assert.equal(decideOffload({ ...pressured, worker: null, workerError: 'timeout' }).offload, false);
    assert.equal(decideOffload({ ...pressured, worker: { ...idleWorker, load1: 12 } }).offload, false);
    assert.equal(decideOffload({ ...pressured, worker: { ...idleWorker, cocoapods: '1.17.0' } }).offload, false);
    assert.equal(decideOffload({ ...pressured, worker: { ...idleWorker, stimBuildId: 'other' } }).offload, false);
    assert.equal(decideOffload({ ...pressured, worker: { ...idleWorker, simulatorSdk: '27.1' } }).offload, false);
  });
});

describe('decideOffload for Android', () => {
  const android = { ndkVersion: '27.1.12297006', buildTools: '37.0.0', compileSdk: '37' };
  const pressured = { ...base, force: true, platform: 'android' as const, android };

  it('offloads when the worker has the JDK major and the SDK pieces the project needs', () => {
    assert.equal(decideOffload(pressured).offload, true);
  });

  it('refuses a JDK major mismatch or a missing NDK, ignoring Xcode and CocoaPods drift', () => {
    assert.equal(decideOffload({ ...pressured, worker: { ...idleWorker, javaMajor: null } }).offload, false);
    assert.equal(decideOffload({ ...pressured, worker: { ...idleWorker, ndk: ['26.1.10909125'] } }).offload, false);
    assert.equal(decideOffload({ ...pressured, worker: { ...idleWorker, cocoapods: '1.17.0' } }).offload, true);
  });
});

describe('parseWorkerOutput', () => {
  it('reads the last marked line and ignores login-shell noise around it', () => {
    const out = `Ignoring json-2.18.1\n${RESULT_MARKER}{"ok":false}\nnoise\n${RESULT_MARKER}{"ok":true}\n`;
    assert.deepEqual(parseWorkerOutput(out), { ok: true });
    assert.equal(parseWorkerOutput('no marker'), null);
  });
});

describe('offloadFindings', () => {
  const toolchains = {
    ios: { ...ios, javaMajor: null },
    android: { xcode: null, simulatorSdk: null, cocoapods: null, javaMajor: '17' },
  };
  const android = { ndkVersion: '27.1.12297006', buildTools: '37.0.0', compileSdk: '37' };
  const args = {
    host: 'mini',
    error: null,
    platforms: ['ios', 'android'] as const,
    toolchains,
    localBuildId: 'abc',
    android,
  };

  it('reports an unreachable worker as a cost', () => {
    const [only] = offloadFindings({ ...args, platforms: ['ios'], worker: null, error: 'timeout' });
    assert.equal(only?.level, 'cost');
  });

  it('names each platform the worker cannot build and notes the ones it can', () => {
    const findings = offloadFindings({
      ...args,
      platforms: ['ios', 'android'],
      worker: { ...idleWorker, javaMajor: '21' },
    });
    assert.deepEqual(
      findings.map((f) => [f.level, f.title]),
      [
        ['cost', 'The offload worker mini cannot build android like this Mac'],
        ['note', 'The offload worker mini can build ios'],
      ],
    );
  });

  it('flags a worker root below the disk gate', () => {
    const findings = offloadFindings({
      ...args,
      platforms: ['ios'],
      worker: { ...idleWorker, diskFreeBytes: 1024 ** 3 },
    });
    assert.ok(findings.some((f) => f.level === 'cost' && f.title.includes('low on disk')));
  });
});
