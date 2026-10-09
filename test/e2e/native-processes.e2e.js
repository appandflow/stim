import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { createCleanupTracker, createHarness, workspaceLogsDir } from './native/harness.mjs';

test('native cleanup inspects only recorded processes and proves their exit', { timeout: 180_000 }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'stim-native-processes-'));
  const previousHome = process.env.STIM_HOME;
  process.env.STIM_HOME = home;
  let child;
  let ended;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await ended;
    if (previousHome === undefined) delete process.env.STIM_HOME;
    else process.env.STIM_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });
  child = spawn(process.execPath, ['-e', "process.send('ready'); setInterval(() => {}, 1000)"], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  ended = new Promise((resolve) => child.once('exit', resolve).once('error', resolve));
  await Promise.race([
    once(child, 'message'),
    ended.then(() => {
      throw new Error('fixture child exited before readiness');
    }),
  ]);
  assert.ok(Number.isSafeInteger(child.pid) && child.pid > 0);
  const cwd = join(home, 'worktree');
  const stateFile = join(workspaceLogsDir(cwd), '..', 'state.json');
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, JSON.stringify({ collectors: { fixture: { pid: child.pid } } }));
  const h = createHarness({ env: { ...process.env, STIM_HOME: home }, label: 'native-processes' });
  const sh = h.sh;
  let captured;
  h.sh = (...args) => {
    const result = sh(...args);
    captured = result.stdout;
    return result;
  };
  const cleanup = createCleanupTracker({ h, platform: 'ios', processExitTimeoutMs: 0 });
  cleanup.recordWorkspace(cwd);
  const capturedPids = captured
    .trim()
    .split('\n')
    .map((line) => Number(line.trim().split(/\s+/)[0]));
  assert.deepEqual(new Set(capturedPids), new Set([child.pid, process.pid]));
  await assert.rejects(() => cleanup.verifyProcesses(), /a workspace process is still running/);
  child.kill('SIGKILL');
  await ended;
  await cleanup.verifyProcesses();
});
