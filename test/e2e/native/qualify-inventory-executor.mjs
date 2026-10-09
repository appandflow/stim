import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { captureProcessIdentity, inspectProcessIdentity } from '../../../packages/core/dist/process-identity.mjs';

assert(process.platform === 'win32' && process.env.CI === '1', 'Windows CI only');
const script = fileURLToPath(import.meta.url);
const root = process.env.STIM_INVENTORY_QUALIFICATION;
assert(root, 'qualification output directory required');
mkdirSync(root, { recursive: true });
const save = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const errorFields = (error) => ({
  message: String(error.message),
  code: error.code ?? null,
  status: error.status ?? null,
  signal: error.signal ?? null,
  pid: error.pid ?? null,
  stdout: String(error.stdout ?? ''),
  stderr: String(error.stderr ?? ''),
});
const [, , role, method, mode] = process.argv;

if (role === 'child') {
  const captured = captureProcessIdentity(process.pid);
  assert(captured.ok, captured.reason);
  save(join(root, 'child.json'), { pid: process.pid, processToken: captured.token });
  process.stdout.write('inventory-out\n');
  process.stderr.write('inventory-err\n');
  setTimeout(() => process.exit(mode === 'failure' ? 23 : 0), mode === 'timeout' ? 9000 : 100);
} else if (role === 'worker') {
  const { getExecutor } = await import('../../../packages/stim-cli/src/exec.ts');
  const started = performance.now();
  let answer;
  try {
    const args = [script, 'child', method, mode];
    const options = { timeoutMs: mode === 'timeout' ? 3000 : 15000, cwd: root };
    const stdout =
      method === 'run'
        ? getExecutor().run([process.execPath, ...args].map((value) => `"${value}"`).join(' '), options)
        : getExecutor().runFile(process.execPath, args, options);
    answer = { ok: true, stdout };
  } catch (error) {
    answer = { ok: false, ...errorFields(error) };
  }
  answer.elapsedMs = Math.round(performance.now() - started);
  const record = existsSync(join(root, 'child.json'))
    ? JSON.parse(readFileSync(join(root, 'child.json'), 'utf8'))
    : null;
  answer.child = record;
  answer.childAtReturn = record ? inspectProcessIdentity(record) : 'unrecorded';
  save(join(root, 'returned.json'), answer);
} else {
  const { getExecutor } = await import('../../../packages/stim-cli/src/exec.ts');
  assert.equal(role, undefined);
  save(join(root, 'source.json'), {
    commit: process.env.GITHUB_SHA,
    node: process.version,
    executorSha256: createHash('sha256')
      .update(readFileSync(new URL('../../../packages/stim-cli/src/exec.ts', import.meta.url)))
      .digest('hex'),
  });
  const results = [];
  for (const candidate of ['run', 'runFile']) {
    for (const scenario of ['success', 'failure', 'timeout']) {
      const directory = join(root, `${candidate}-${scenario}`);
      mkdirSync(directory);
      const result = spawnSync(process.execPath, [script, 'worker', candidate, scenario], {
        env: { ...process.env, STIM_INVENTORY_QUALIFICATION: directory },
        cwd: directory,
        encoding: 'utf8',
        timeout: 25000,
        maxBuffer: 1024 * 1024,
      });
      save(join(directory, 'worker-result.json'), {
        status: result.status,
        signal: result.signal,
        stdout: result.stdout,
        stderr: result.stderr,
        error: result.error ? errorFields(result.error) : null,
      });
      const record = existsSync(join(directory, 'child.json'))
        ? JSON.parse(readFileSync(join(directory, 'child.json'), 'utf8'))
        : null;
      const observations = [];
      if (record) {
        const deadline = Date.now() + 12000;
        for (;;) {
          const state = inspectProcessIdentity(record);
          observations.push({ at: new Date().toISOString(), state });
          save(join(directory, 'settlement.json'), { record, observations });
          if (state === 'gone' || state === 'different' || Date.now() >= deadline) break;
          await sleep(100);
        }
      }
      assert.equal(result.error, undefined, `${candidate}/${scenario}: worker did not settle`);
      assert.equal(result.status, 0, `${candidate}/${scenario}: ${result.stderr}`);
      assert(record, `${candidate}/${scenario}: child identity was not published`);
      assert(['gone', 'different'].includes(observations.at(-1)?.state), 'finite child did not settle');
      const answer = JSON.parse(readFileSync(join(directory, 'returned.json'), 'utf8'));
      results.push({ method: candidate, scenario, ...answer });
      save(join(root, 'observations.json'), results);
      assert.equal(answer.ok, scenario === 'success');
      assert.equal(answer.stdout.trim(), 'inventory-out');
      if (scenario !== 'success') assert.equal(answer.stderr.trim(), 'inventory-err');
      if (scenario === 'failure') assert.equal(answer.status, 23);
      if (scenario === 'timeout') assert.equal(answer.code, 'ETIMEDOUT');
      if (candidate === 'runFile') {
        assert(['gone', 'different'].includes(answer.childAtReturn), 'direct child still alive when executor returned');
        if (scenario === 'timeout') assert(answer.elapsedMs < 6000, 'direct timeout did not return within allowance');
      }
    }
  }
  const adb = getExecutor().findExecutable('adb');
  assert(adb, 'installed platform-tools adb required');
  const version = getExecutor().runFile(adb, ['version'], { timeoutMs: 5000, cwd: root });
  save(join(root, 'adb-version.json'), { version });
  assert.match(version, /Version 37\.0\.1-/);
  for (const candidate of ['run', 'runFile']) {
    const started = performance.now();
    let observation;
    try {
      const options = { timeoutMs: 5000, cwd: root };
      const stdout =
        candidate === 'run'
          ? getExecutor().run(`"${adb}" devices`, options)
          : getExecutor().runFile(adb, ['devices'], options);
      observation = { ok: true, stdout };
    } catch (error) {
      observation = { ok: false, ...errorFields(error) };
    }
    observation.elapsedMs = Math.round(performance.now() - started);
    save(join(root, `adb-${candidate}.json`), observation);
    assert(observation.ok, `actual adb inventory failed via ${candidate}`);
    assert.match(observation.stdout, /^List of devices attached/);
  }
  save(join(root, 'qualified.json'), {
    scope: 'finite owned fixture and unloaded actual adb inventory; no loaded stop or cleanup proof',
    shellTimeout: results.find((entry) => entry.method === 'run' && entry.scenario === 'timeout'),
    directTimeout: results.find((entry) => entry.method === 'runFile' && entry.scenario === 'timeout'),
  });
  console.log(
    'Executor observations recorded; direct timeout, finite child settlement and actual adb inventory qualified',
  );
}
