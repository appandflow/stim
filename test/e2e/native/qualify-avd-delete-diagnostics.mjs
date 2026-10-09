import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

assert(process.platform === 'win32' && process.env.CI === '1', 'Windows CI only');
const root = 'D:\\e\\avd-delete-qualification';
mkdirSync(root, { recursive: true });
const childScript = join(root, 'child.mjs');
writeFileSync(
  childScript,
  `
import { writeFileSync } from 'node:fs';
writeFileSync(process.env.PROBE_PID_FILE, String(process.pid));
process.stdout.write('sdk-out\\n'); process.stderr.write('sdk-err\\n');
setTimeout(() => process.exit(Number(process.env.PROBE_EXIT)), 4000);
`,
);
const sdk = join(root, 'avdmanager.bat');
writeFileSync(sdk, `@echo off\r\n"${process.execPath}" "${childScript}"\r\nexit /b %errorlevel%\r\n`);
const caller = join(root, 'caller.mjs');
writeFileSync(
  caller,
  `
import { execSync } from 'node:child_process';
try {
  const stdout = execSync(process.env.PROBE_COMMAND, { encoding: 'utf8', stdio: ['pipe','pipe','pipe'], timeout: Number(process.env.PROBE_TIMEOUT), killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024, env: process.env });
  process.stdout.write(JSON.stringify({ ok: true, stdout }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, code: error.code, status: error.status, signal: error.signal, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') }));
}
`,
);
const results = [];
for (const mode of ['success', 'failure', 'timeout']) {
  const answers = [];
  for (const observed of [false, true]) {
    const name = `${mode}-${observed ? 'observed' : 'original'}`;
    const directory = join(root, name);
    mkdirSync(directory);
    const pidFile = join(directory, 'child-pid');
    const diagnostic = join(directory, 'diagnostics');
    const run = spawnSync(
      process.execPath,
      [...(observed ? ['--require', join(import.meta.dirname, 'avd-delete-preload.cjs')] : []), caller],
      {
        env: {
          ...process.env,
          STIM_E2E_AVD_DIAGNOSTICS: diagnostic,
          ANDROID_AVD_HOME: directory,
          PROBE_PID_FILE: pidFile,
          PROBE_EXIT: mode === 'failure' ? '23' : '0',
          PROBE_TIMEOUT: mode === 'timeout' ? '1500' : '120000',
          PROBE_COMMAND: `"${sdk}" delete avd -n "stim-observer-fixture"`,
        },
        encoding: 'utf8',
        timeout: 30000,
        maxBuffer: 1024 * 1024,
      },
    );
    writeFileSync(
      join(directory, 'spawn-result.json'),
      JSON.stringify(
        {
          status: run.status,
          signal: run.signal,
          error: run.error ? { code: run.error.code, message: run.error.message } : null,
          stdout: run.stdout,
          stderr: run.stderr,
        },
        null,
        2,
      ),
    );
    assert.equal(run.error, undefined, name);
    assert.equal(run.status, 0, `${name}: ${run.stderr}`);
    const answer = JSON.parse(run.stdout);
    answers.push(answer);
    const childPid = Number(readFileSync(pidFile, 'utf8'));
    assert(Number.isSafeInteger(childPid) && childPid > 0);
    const deadline = Date.now() + 5000;
    for (;;) {
      try {
        process.kill(childPid, 0);
      } catch (error) {
        assert.equal(error.code, 'ESRCH');
        break;
      }
      assert(Date.now() < deadline, 'qualification child did not exit');
      await sleep(100);
    }
    if (!observed) continue;
    const files = readdirSync(diagnostic);
    assert.equal(files.length, 1);
    const rows = readFileSync(join(diagnostic, files[0]), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const starts = rows.filter((row) => row.event === 'observer.query-start');
    const closes = rows.filter((row) => row.event === 'observer.query-close');
    assert(starts.length > 0);
    assert.equal(closes.length, starts.length);
    for (const query of starts)
      assert.equal(closes.filter((row) => row.pid === query.pid && row.code === 0 && row.signal === null).length, 1);
    assert(
      rows.some(
        (row) =>
          row.event === 'sample' &&
          row.processes.some((entry) => entry.pid === childPid && entry.birth && entry.observation === 'same'),
      ),
    );
    assert(rows.some((row) => row.event === 'observer.complete'));
    assert(rows.some((row) => row.event === 'observer.settlement' && row.state === 1));
    assert(!rows.some((row) => row.event === 'observer.failed' || row.event === 'observer.worker-error'));
    const returned = rows.find((row) => row.event === (mode === 'success' ? 'exec.return' : 'exec.throw'));
    assert(returned);
    assert.equal(returned.stdout, answer.stdout);
    if (mode !== 'success')
      for (const key of ['code', 'status', 'signal', 'stderr']) assert.equal(returned[key], answer[key]);
    results.push({ mode, answer, childPid, queryPairs: starts.length });
  }
  assert.deepEqual(answers[1], answers[0], `${mode}: preload changed the original command result`);
  assert.equal(answers[0].ok, mode === 'success');
  if (mode === 'timeout') assert.equal(answers[0].code, 'ETIMEDOUT');
  if (mode === 'failure') assert.equal(answers[0].status, 23);
}
writeFileSync(join(root, 'qualified.json'), JSON.stringify(results, null, 2));
console.log('AVD diagnostic hook: ESM import, original results, real descendants and observer settlement qualified');
