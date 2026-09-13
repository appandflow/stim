import assert from 'node:assert/strict';
import { once } from 'node:events';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { removeGradleHome } from './native/gradle-home.mjs';
import { getExecutor } from '../../packages/stim-cli/src/exec.ts';

const cleanupModule = fileURLToPath(new URL('./native/gradle-home.mjs', import.meta.url));

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-gradle-cleanup-')));
  const home = join(root, 'owned');
  mkdirSync(home);
  writeFileSync(join(home, 'owner.pid'), String(process.pid));
  const previousHome = process.env.STIM_HOME;
  process.env.STIM_HOME = root;
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.STIM_HOME;
    else process.env.STIM_HOME = previousHome;
  });
  return { root, home };
}

function registry(home, pid) {
  const dir = join(home, 'daemon', '9.0.0');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'registry.bin'), 'fixture');
  if (pid) writeFileSync(join(dir, `daemon-${pid}.out.log`), 'fixture');
}

function binary(home, script) {
  const path = join(home, 'wrapper', 'dists', 'gradle-9.0.0-bin', 'hash', 'gradle-9.0.0', 'bin', 'gradle');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!${process.execPath}\n${script}\n`);
  chmodSync(path, 0o755);
}

async function child(t, code, args = []) {
  const process = getExecutor().spawn(globalThis.process.execPath, ['--input-type=module', '-e', code, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => {
    if (process.exitCode === null && process.signalCode === null) process.kill('SIGKILL');
  });
  return process;
}

test('Gradle cleanup waits for daemon exit and leaves another home running', { timeout: 15000 }, async (t) => {
  const { root, home } = fixture(t);
  const marker = join(root, 'daemon-exited');
  const daemon = await child(
    t,
    `
    import { writeFileSync } from 'node:fs';
    process.on('SIGTERM', () => setTimeout(() => {
      writeFileSync(${JSON.stringify(marker)}, 'done');
      process.exit(0);
    }, 300));
    console.log('ready');
    setInterval(() => {}, 1000);
  `,
  );
  await once(daemon.stdout, 'data');
  const unrelated = await child(t, "console.log('ready'); setInterval(() => {}, 1000)");
  await once(unrelated.stdout, 'data');
  registry(home, daemon.pid);
  const invoked = join(root, 'invoked.json');
  binary(
    home,
    `
    const fs = require('node:fs');
    fs.writeFileSync(${JSON.stringify(invoked)}, JSON.stringify({args: process.argv.slice(2), home: process.env.GRADLE_USER_HOME}));
    process.kill(${daemon.pid}, 'SIGTERM');
  `,
  );
  const cleanup = await child(
    t,
    `
    import { writeFileSync } from 'node:fs';
    import { removeGradleHome } from ${JSON.stringify(cleanupModule)};
    writeFileSync(${JSON.stringify(join(home, 'owner.pid'))}, String(process.pid));
    removeGradleHome(${JSON.stringify(home)});
  `,
  );
  let stderr = '';
  cleanup.stderr.on('data', (data) => (stderr += data));
  const [code] = await once(cleanup, 'close');
  assert.equal(code, 0, stderr);
  assert.equal(existsSync(marker), true);
  assert.equal(existsSync(home), false);
  assert.equal(unrelated.exitCode, null);
  assert.doesNotThrow(() => process.kill(unrelated.pid, 0));
  assert.deepEqual(JSON.parse(readFileSync(invoked, 'utf8')), {
    args: ['--stop', '--gradle-user-home', home],
    home,
  });
});

test('Gradle stop failure retains its registry and home', (t) => {
  const { home } = fixture(t);
  registry(home);
  binary(home, 'process.exit(7);');
  assert.throws(() => removeGradleHome(home));
  assert.equal(existsSync(join(home, 'daemon', '9.0.0', 'registry.bin')), true);
});

test('Gradle cleanup retains a live daemon when its distribution is missing', (t) => {
  const { home } = fixture(t);
  registry(home, process.pid);
  assert.throws(() => removeGradleHome(home), /No cached Gradle/);
  assert.equal(existsSync(home), true);
});

test('Gradle cleanup refuses missing ownership and another live owner', (t) => {
  const { home } = fixture(t);
  rmSync(join(home, 'owner.pid'));
  assert.throws(() => removeGradleHome(home));
  writeFileSync(join(home, 'owner.pid'), String(process.ppid));
  assert.throws(() => removeGradleHome(home), /Cannot prove/);
  assert.equal(existsSync(home), true);
});

test('Gradle cleanup refuses a registry linked outside its home', (t) => {
  const { root, home } = fixture(t);
  const unrelated = join(root, 'unrelated');
  mkdirSync(unrelated);
  symlinkSync(unrelated, join(home, 'daemon'));
  assert.throws(() => removeGradleHome(home), /registry leaves/);
  assert.equal(existsSync(unrelated), true);
  assert.equal(existsSync(home), true);
});
