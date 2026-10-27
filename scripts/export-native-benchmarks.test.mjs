import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { exportNativeBenchmarks } from './export-native-benchmarks.mjs';

let root;
const write = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
};
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const files = [
  'events.jsonl',
  'commands.json',
  'source.diff',
  'proof/target.json',
  'proof/screen.png',
  'proof/coordinator-snapshot.txt',
  'proof/coordinator-process-before.json',
  'proof/coordinator-process-after.json',
];

function pair(platform, cohort = 'standalone-native-v1') {
  for (const arm of ['stim', 'control']) {
    const id = `${platform}-${arm}`;
    const dir = join(root, 'native', platform, 'results', id);
    for (const name of files) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), `${id}: ${name}`);
    }
    const runnerResult = { code: 0, timedOut: false };
    write(join(dir, 'meta.json'), {
      cohort,
      runId: id,
      platform,
      arm,
      model: 'gpt-5.6-luna',
      reasoningEffort: 'high',
      serviceTier: 'priority',
      dispatchAt: '2026-10-13T00:00:00.000Z',
      finishedAt: `2026-10-13T00:0${arm === 'stim' ? 1 : 2}:00.000Z`,
      runnerResult,
      fixture: { framework: `native-${platform}` },
      compatibility: { manifestSha256: 'compat' },
      coordinatorHashes: { 'native-driver.mjs': 'a'.repeat(64), 'native-task.mjs': 'b'.repeat(64) },
      provenance: Object.fromEntries(
        [
          'fixtureCommit',
          'stimVersion',
          'stimCliSha256',
          'nodeVersion',
          'macosVersion',
          'macosBuild',
          'xcodeVersion',
          'xcodeBuild',
          'codexVersion',
        ].map((key) => [key, 'same']),
      ),
    });
    write(join(dir, 'run.json'), {
      cohort,
      runId: id,
      platform,
      arm,
      source: true,
      invalidReasons: [],
      runnerResult,
      elapsedSeconds: arm === 'stim' ? 60 : 120,
      eventsSha256: hash(join(dir, 'events.jsonl')),
      screenshotSha256: hash(join(dir, 'proof/screen.png')),
    });
    write(join(dir, 'audit.json'), {
      status: 'accepted',
      valid: true,
      checks: Object.fromEntries(
        [
          'sourceExact',
          'runnerCompleted',
          'buildCompleted',
          'commandAudit',
          'processUnchanged',
          'revisionAndCountVisuallyVerified',
        ].map((key) => [key, true]),
      ),
      hashes: Object.fromEntries(files.map((name) => [name, hash(join(dir, name))])),
    });
    write(join(dir, 'cleanup.json'), { status: 'complete' });
  }
  write(join(root, 'native', platform, 'comparison.json'), {
    results: { stim: { runId: `${platform}-stim` }, control: { runId: `${platform}-control` } },
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stim-native-export-'));
  write(join(root, 'targets.json'), { machine: 'Test machine' });
  pair('ios');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const publish = () => exportNativeBenchmarks(root, join(root, 'published/data.json'), join(root, 'published/proof'));

it('publishes accepted native pairs without local paths and adds Android only when a pair exists', () => {
  pair('macos');
  const first = publish();
  expect(first.pairs.map((entry) => entry.platform)).toEqual(['ios', 'macos']);
  expect(first.pairs[0]).toMatchObject({
    timeReductionPercent: 50,
    samplePairs: 1,
    runs: [{ taskSeconds: 60 }, { taskSeconds: 120 }],
  });
  expect(JSON.stringify(first)).not.toContain(root);
  expect(hash(join(root, 'published/proof/ios-stim.png'))).toBe(first.pairs[0].runs[0].evidence.proofSha256);
  pair('android', 'standalone-native-v2');
  const second = publish();
  expect(second.pairs.map((entry) => [entry.platform, entry.cohort])).toEqual([
    ['ios', 'standalone-native-v1'],
    ['android', 'standalone-native-v2'],
    ['macos', 'standalone-native-v1'],
  ]);
});

it.each([
  'proof',
  'missing evidence',
  'audit',
  'cleanup',
  'timing',
  'model',
  'version',
  'identity',
  'timeout',
  'cohort',
  'protocol',
  'missing protocol',
])('refuses %s problems before publishing any partial comparison', (failure) => {
  const dir = join(root, 'native/ios/results/ios-control');
  const update = (name, change) => {
    const path = join(dir, name);
    const value = JSON.parse(readFileSync(path));
    change(value);
    write(path, value);
  };
  if (failure === 'proof') writeFileSync(join(dir, 'proof/screen.png'), 'changed');
  if (failure === 'missing evidence') update('audit.json', (value) => delete value.hashes['source.diff']);
  if (failure === 'audit') update('audit.json', (value) => (value.valid = false));
  if (failure === 'cleanup') update('cleanup.json', (value) => (value.status = 'failed'));
  if (failure === 'timing') update('run.json', (value) => (value.elapsedSeconds = 1));
  if (failure === 'model') update('meta.json', (value) => (value.model = 'different'));
  if (failure === 'version') update('meta.json', (value) => (value.provenance.stimVersion = 'different'));
  if (failure === 'identity') update('audit.json', (value) => (value.checks.processUnchanged = false));
  if (failure === 'timeout') update('run.json', (value) => (value.runnerResult.timedOut = true));
  if (failure === 'cohort') {
    update('meta.json', (value) => (value.cohort = 'standalone-native-v2'));
    update('run.json', (value) => (value.cohort = 'standalone-native-v2'));
  }
  if (failure === 'protocol')
    update('meta.json', (value) => (value.coordinatorHashes['native-task.mjs'] = 'c'.repeat(64)));
  if (failure === 'missing protocol') update('meta.json', (value) => delete value.coordinatorHashes);
  expect(publish).toThrow(/Native/);
  expect(existsSync(join(root, 'published'))).toBe(false);
});
