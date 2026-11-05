import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createHarness, preflight } from './native/harness.mjs';

function scratch(t) {
  const root = mkdtempSync(join(tmpdir(), 'stim-native-preflight-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function harness(env) {
  const tools = [];
  return {
    env,
    tools,
    cli: () => ({ code: 0, stdout: 'test-version', stderr: '' }),
    log() {},
    requireTool: (file) => tools.push(file),
  };
}

test('native Android preflight refuses missing or invalid SDK paths before checking tools', (t) => {
  const root = scratch(t);
  for (const env of [{}, { ANDROID_HOME: join(root, 'missing') }]) {
    const h = harness(env);
    assert.throws(() => preflight(h, 'android'), /Android SDK/);
    assert.deepEqual(h.tools, []);
  }
  const file = join(root, 'not-a-directory');
  writeFileSync(file, 'file');
  assert.throws(() => preflight(harness({ ANDROID_HOME: file }), 'android'), /SDK directory/);
});

test('native Android preflight accepts either explicit SDK environment variable', (t) => {
  const root = scratch(t);
  for (const key of ['ANDROID_HOME', 'ANDROID_SDK_ROOT']) {
    const h = harness({ [key]: root });
    preflight(h, 'android');
    assert.deepEqual(h.tools, ['adb']);
  }
});

test('native iOS preflight rejects an ASCII locale before any Xcode or fixture work', (t) => {
  const root = scratch(t);
  const env = { ...process.env, STIM_HOME: join(root, 'home'), LANG: 'C', LC_ALL: 'C' };
  const h = createHarness({ env, cliPath: '', label: 'locale' });
  h.cli = () => ({ code: 0, stdout: 'test-version', stderr: '' });
  h.requireTool = () => assert.fail('tool preparation must not start');
  assert.throws(() => preflight(h, 'ios'), /require a UTF-8 locale.*LANG=.*LC_ALL=/);
});

test('cache runner rejects a missing Android SDK before cloning or sweeping Gradle homes', (t) => {
  const root = scratch(t);
  const gradle = join(root, 'gradle');
  const residue = join(root, '.stim-e2e-gradle-unrelated');
  const temp = join(root, 'tmp');
  mkdirSync(gradle);
  mkdirSync(residue);
  mkdirSync(temp);
  writeFileSync(join(residue, 'owner.pid'), '999999999');
  writeFileSync(join(residue, 'keep'), 'unrelated');
  const summary = join(root, 'summary.json');
  const env = { ...process.env, PATH: '', GRADLE_USER_HOME: gradle, TMPDIR: temp, STIM_HOME: join(root, 'home') };
  delete env.ANDROID_HOME;
  delete env.ANDROID_SDK_ROOT;
  const result = spawnSync(
    process.execPath,
    ['test/e2e/native/run-cache-e2e.mjs', '--framework', 'expo', '--platform', 'android', '--summary', summary],
    { env, encoding: 'utf-8', timeout: 10_000 },
  );
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /require ANDROID_HOME or ANDROID_SDK_ROOT/);
  assert.equal(readFileSync(join(residue, 'keep'), 'utf-8'), 'unrelated');
  assert.deepEqual(
    readdirSync(root).filter((name) => name.startsWith('.stim-e2e-gradle-')),
    ['.stim-e2e-gradle-unrelated'],
  );
  const report = JSON.parse(readFileSync(summary, 'utf-8'));
  assert.equal(report.ok, false);
  assert.equal(report.counts.missing, 8);
  assert.doesNotMatch(result.stderr, /creating expo fixture|gradle home seed:/);
});
