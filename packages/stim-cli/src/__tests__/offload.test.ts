import assert from 'node:assert';
import { decideOffload } from '../offload/client.ts';
import { RESULT_MARKER, parseWorkerOutput, type WorkerProbe } from '../offload/protocol.ts';

const toolchain = { xcode: 'Xcode 27.0 / Build version 27A266a', simulatorSdk: '27.0', cocoapods: '1.16.2' };
const idleWorker: WorkerProbe = {
  stimVersion: '1.14.0',
  stimBuildId: 'abc',
  ...toolchain,
  runtimes: ['iOS 27.0'],
  node: 'v26.7.0',
  arch: process.arch,
  cpus: 10,
  load1: 2,
  availableMemBytes: 6 * 1024 ** 3,
  diskFreeBytes: 20 * 1024 ** 3,
  xcodebuildRunning: 0,
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

describe('parseWorkerOutput', () => {
  it('reads the last marked line and ignores login-shell noise around it', () => {
    const out = `Ignoring json-2.18.1\n${RESULT_MARKER}{"ok":false}\nnoise\n${RESULT_MARKER}{"ok":true}\n`;
    assert.deepEqual(parseWorkerOutput(out), { ok: true });
    assert.equal(parseWorkerOutput('no marker'), null);
  });
});
