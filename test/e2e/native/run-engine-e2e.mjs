// The engine suite: the engine store and stimd together, on the built package, under scratch homes and engine
// roots only. Run with `node test/e2e/native/run-engine-e2e.mjs` after `pnpm run build`.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, before, test } from 'node:test';

const REPO = resolve(import.meta.dirname, '../../..');
const WIN = process.platform === 'win32';
const npm = WIN ? 'npm.cmd' : 'npm';
const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'stim-engine-e2e-')));
const installed = (prefix) => join(prefix, ...(WIN ? [] : ['lib']), 'node_modules', 'stim');
const STAGINGS = Number(process.env.STIM_E2E_STAGINGS ?? 80);
const COLD_RUNS = 10;
// Fresh machine up to the op.begin reply, and idle restart (no clone), p95 in ms (design targets).
const BUDGETS = {
  darwin: { cold: 1000, idle: 300 },
  linux: { cold: 1500, idle: 400 },
  win32: { cold: 4000, idle: 1500 },
}[process.platform];
const children = new Set();
const results = [];
let copy;
let version;

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const p = (times, q) => times.toSorted((a, b) => a - b)[Math.min(times.length - 1, Math.floor(times.length * q))];
const until = async (what, check, timeoutMs = 30_000) => {
  for (const deadline = Date.now() + timeoutMs; !check();) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 10));
  }
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A scratch machine: its own HOME, Stim home and engine root. */
function machine(name) {
  const dir = join(tmp, name);
  const home = join(dir, 'home');
  mkdirSync(home, { recursive: true });
  return {
    dir,
    root: join(dir, 'engine'),
    stimHome: join(home, '.stim'),
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      STIM_HOME: join(home, '.stim'),
      STIM_ENGINE_ROOT: join(dir, 'engine'),
      STIM_DAEMON: 'on',
      STIM_NO_UPDATE_CHECK: '1',
    },
  };
}

const stim = (m, dir, args, options = {}) =>
  spawnSync(process.execPath, [join(dir, 'bin', 'stim.mjs'), ...args], {
    env: m.env,
    cwd: m.dir,
    encoding: 'utf8',
    ...options,
  });
const record = (m) => {
  try {
    return readJson(join(m.stimHome, 'run', 'stimd.json'));
  } catch {
    return null;
  }
};

/** A copy of the installed package at `dir` with its own version and build id. */
function variant(dir, nextVersion, mark) {
  const manifest = readJson(join(dir, 'package.json'));
  manifest.version = nextVersion;
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest));
  appendFileSync(join(dir, 'dist', 'cli.mjs'), `\n// ${mark}\n`);
}

function startStimd(m, build) {
  const child = spawn(process.execPath, [join(m.root, build, 'dist', 'cli.mjs'), '__stimd', '--mode', 'report'], {
    env: m.env,
    cwd: m.dir,
    stdio: 'ignore',
    detached: !WIN,
  });
  children.add(child);
  return child;
}

async function stopStimd(m) {
  const pid = record(m)?.pid;
  if (!pid) return;
  if (alive(pid)) process.kill(pid, 'SIGTERM');
  await until('stimd to exit', () => !alive(pid)).catch(() => {});
}

/** One connection to stimd with the first frame of `build` and `ops`; resolves once it has `answers` lines. */
function ask(socketPath, build, ops, answers) {
  return new Promise((resolveAsk, reject) => {
    const socket = connect(socketPath);
    const replies = [];
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('error', reject);
    socket.on('data', (chunk) => {
      buffer += chunk;
      for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
        replies.push(JSON.parse(buffer.slice(0, at)));
        buffer = buffer.slice(at + 1);
        if (replies.length === answers) resolveAsk({ socket, replies });
      }
    });
    socket.once('connect', () =>
      socket.write([{ kind: 'cli', build }, ...ops].map((line) => `${JSON.stringify(line)}\n`).join('')),
    );
  });
}

/** Spawns stimd from the current build and times it up to its op.begin reply. */
async function bootToOpBegin(m) {
  const build = readJson(join(m.root, 'current.json')).dir;
  const started = performance.now();
  startStimd(m, build);
  await until('stimd to write its record', () => record(m)?.build === build, 20_000);
  const { socket, replies } = await ask(record(m).socket, build, [{ op: 'op.begin' }], 2);
  socket.destroy();
  assert.deepEqual(
    replies.map((reply) => reply.op),
    ['hello', 'op.begun'],
  );
  return performance.now() - started;
}

function rssKb(pid) {
  if (WIN) return null;
  return Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim());
}

before(() => {
  const packed = execFileSync(npm, ['pack', '--pack-destination', tmp], {
    cwd: join(REPO, 'packages', 'stim-cli'),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    shell: WIN,
  })
    .trim()
    .split('\n')
    .at(-1);
  const prefix = join(tmp, 'a', 'npm');
  execFileSync(
    npm,
    ['install', '-g', '--prefix', prefix, join(tmp, packed), '--ignore-scripts', '--no-audit', '--no-fund'],
    { env: { ...process.env, npm_config_loglevel: 'error' }, shell: WIN, stdio: 'ignore' },
  );
  copy = installed(prefix);
  version = readJson(join(copy, 'package.json')).version.split(/[.-]/).slice(0, 3).map(Number);
});

after(async () => {
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
  for (const name of readdirSync(tmp)) {
    const file = join(tmp, name, 'home', '.stim', 'run', 'stimd.json');
    if (existsSync(file)) {
      const { pid } = readJson(file);
      if (alive(pid)) process.kill(pid, 'SIGTERM');
    }
  }
  spawnSync(WIN ? 'attrib' : 'chmod', WIN ? ['-r', `${tmp}\\*`, '/s', '/d'] : ['-R', 'u+w', tmp]);
  rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
  console.log(`\nengine e2e results (${process.platform})\n${results.map((line) => `  ${line}`).join('\n')}`);
});

const at = (n) => `${version[0]}.${version[1]}.${version[2] + n}`;

test(
  `(a) ${STAGINGS} stagings in a row keep at most 3 builds and an empty .trash`,
  {
    timeout: 900_000,
    todo: WIN && 'store GC keeps every tree where it cannot list processes (Windows); the count is recorded',
  },
  () => {
    const m = machine('stagings');
    const b = installed(join(m.dir, 'npm'));
    cpSync(copy, b, { recursive: true, verbatimSymlinks: true });
    const install = stim(m, b, ['engine', 'install']);
    assert.equal(install.status, 0, install.stderr);
    const started = performance.now();
    for (let n = 1; n <= STAGINGS; n++) {
      variant(b, at(n), `staging ${n}`);
      const run = stim(m, b, ['engine', 'status', '--json']);
      assert.equal(run.status, 0, run.stderr);
      assert.equal(JSON.parse(run.stdout).current.version, at(n), run.stderr);
    }
    const perStaging = (performance.now() - started) / STAGINGS;
    const builds = readdirSync(m.root).filter((name) => /^[0-9a-f]{12}$/.test(name));
    const trash = readdirSync(join(m.root, '.trash'));
    results.push(
      `(a) ${STAGINGS} stagings: ${builds.length} builds left, ${trash.length} in .trash, ${perStaging.toFixed(0)} ms each`,
    );
    assert.ok(builds.length <= 3, `${builds.length} builds in the store: ${builds.join(', ')}`);
    assert.deepEqual(trash, []);
  },
);

test(
  '(d) a switch under load: builds in flight hold the flip, a waiting build holds at its slot, then flip',
  {
    skip: WIN && 'the switch path is not exercised on Windows yet (stimd.integration skips it there too)',
    timeout: 300_000,
  },
  async () => {
    const m = machine('switch');
    const a = installed(join(m.dir, 'a', 'npm'));
    const b = installed(join(m.dir, 'b', 'npm'));
    cpSync(copy, a, { recursive: true, verbatimSymlinks: true });
    cpSync(copy, b, { recursive: true, verbatimSymlinks: true });
    variant(b, at(1), 'switch b');
    assert.equal(stim(m, a, ['engine', 'install']).status, 0);
    const buildA = readJson(join(m.root, 'current.json')).dir;
    startStimd(m, buildA);
    await until('stimd of A', () => record(m)?.build === buildA);
    const first = record(m).pid;
    const slots = pathToFileURL(join(REPO, 'packages', 'stim-cli', 'src', 'engine', 'build-slots.ts')).href;

    const inFlight = [];
    for (let n = 0; n < 3; n++) {
      const child = spawn(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import { connect } from 'node:net';
        import { releaseBuildSlot, tryAcquireBuildSlot } from ${JSON.stringify(slots)};
        const slot = tryAcquireBuildSlot({ max: 8, root: process.cwd() });
        const socket = connect(${JSON.stringify(record(m).socket)});
        socket.write(JSON.stringify({ kind: 'cli', build: ${JSON.stringify(buildA)} }) + '\\n' + JSON.stringify({ op: 'op.begin' }) + '\\n');
        socket.on('data', (chunk) => String(chunk).includes('op.begun') && process.stdout.write('building\\n'));
        process.stdin.on('end', () => { releaseBuildSlot(slot); socket.destroy(); });
        process.stdin.resume();`,
        ],
        { env: m.env, cwd: m.dir, stdio: ['pipe', 'pipe', 'inherit'] },
      );
      children.add(child);
      await new Promise((done) => child.stdout.once('data', done));
      inFlight.push(child);
    }

    const watch = spawn(process.execPath, [join(m.root, buildA, 'dist', 'cli.mjs'), 'status', '--watch'], {
      env: m.env,
      cwd: m.dir,
      stdio: 'ignore',
    });
    children.add(watch);
    const watched = new Promise((done) => watch.once('exit', done));

    const stage = spawnSync(process.execPath, [join(b, 'dist', 'engine-select.mjs'), '--explicit', '--set-by', 'e2e'], {
      env: m.env,
      cwd: m.dir,
      encoding: 'utf8',
    });
    const buildB = JSON.parse(stage.stdout).staged;
    assert.match(buildB, /^[0-9a-f]{12}$/, stage.stdout + stage.stderr);

    const waiting = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { acquireBuildSlot } from ${JSON.stringify(slots)};
      acquireBuildSlot({ max: 8, engine: { root: ${JSON.stringify(m.root)}, build: ${JSON.stringify(buildA)} }, intervalMs: 20, out: (line) => console.log(line) })
        .then(() => console.log('took a slot'), (error) => console.log(error.code + ': ' + error.message));`,
      ],
      { env: m.env, cwd: m.dir, stdio: ['ignore', 'pipe', 'inherit'] },
    );
    children.add(waiting);
    let waitingOut = '';
    waiting.stdout.on('data', (chunk) => (waitingOut += String(chunk)));
    const waited = new Promise((done) => waiting.once('exit', done));
    await until('the slot hold line', () => waitingOut.includes('switching Stim'));
    assert.match(
      waitingOut,
      new RegExp(`switching Stim to ${at(1).replaceAll('.', '\\.')}; waiting for 3 running builds`),
    );

    await new Promise((done) => setTimeout(done, 1000));
    assert.equal(readJson(join(m.root, 'current.json')).dir, buildA, 'the flip waits for the builds in flight');
    for (const child of inFlight.slice(0, -1)) child.stdin.end();
    await new Promise((done) => setTimeout(done, 500));
    assert.equal(readJson(join(m.root, 'current.json')).dir, buildA, 'one build in flight still holds the flip');
    inFlight.at(-1).stdin.end();
    const released = performance.now();
    await until('the successor stimd of B', () => record(m)?.build === buildB, 60_000);
    const flipMs = performance.now() - released;
    await until('A to exit', () => !alive(first));
    await waited;
    assert.equal(readJson(join(m.root, 'current.json')).dir, buildB);
    assert.match(
      waitingOut,
      new RegExp(`STIM_ENGINE_SWITCHED: Stim updated to ${at(1).replaceAll('.', '\\.')}; rerun`),
    );
    assert.equal(await watched, 75);
    results.push(
      `(d) switch under load: 3 builds in flight, 1 at its slot; flip ${flipMs.toFixed(0)} ms after the last`,
    );
    await stopStimd(m);
  },
);

test('(s) stim status --json answers from stimd with ageMs, without the CLI', { timeout: 120_000 }, async () => {
  const m = machine('status');
  const a = installed(join(m.dir, 'a', 'npm'));
  cpSync(copy, a, { recursive: true, verbatimSymlinks: true });
  assert.equal(stim(m, a, ['engine', 'install']).status, 0);
  const build = readJson(join(m.root, 'current.json')).dir;
  startStimd(m, build);
  await until('stimd', () => record(m)?.build === build);
  const idleRss = (await new Promise((done) => setTimeout(done, 3000)), rssKb(record(m).pid));
  const times = [];
  let last;
  for (let n = 0; n < 21; n++) {
    const started = performance.now();
    const run = stim(m, a, ['status', '--json']);
    times.push(performance.now() - started);
    assert.equal(run.status, 0, run.stderr);
    last = JSON.parse(run.stdout);
    if (n > 0) assert.equal(typeof last.ageMs, 'number', `call ${n} was not answered from the snapshot`);
  }
  assert.ok(Array.isArray(last.environments), 'the payload is the status payload');
  assert.equal(typeof last.ageMs, 'number', 'answered from the snapshot, which carries its age');
  const fresh = JSON.parse(stim(m, a, ['status', '--json', '--fresh']).stdout);
  assert.ok(fresh.ageMs < 5000);
  const statusRss = rssKb(record(m).pid);
  results.push(
    `(s) status --json from the snapshot: p50 ${p(times.slice(1), 0.5).toFixed(0)} ms, first ${times[0].toFixed(0)} ms` +
      (idleRss
        ? `; stimd RSS ${Math.round(idleRss / 1024)} MB idle, ${Math.round(statusRss / 1024)} MB after status`
        : ''),
  );
  await stopStimd(m);
});

const cold = [];
const install = [];
const idle = [];

test('(f) cold start and idle restart, each up to the op.begin reply', { timeout: 600_000 }, async () => {
  for (let n = 0; n < COLD_RUNS; n++) {
    const m = machine(`cold-${n}`);
    const a = installed(join(m.dir, 'a', 'npm'));
    cpSync(copy, a, { recursive: true, verbatimSymlinks: true });
    const started = performance.now();
    const run = stim(m, a, ['engine', 'install']);
    assert.equal(run.status, 0, run.stderr);
    install.push(performance.now() - started);
    cold.push(install.at(-1) + (await bootToOpBegin(m)));
    await stopStimd(m);
    idle.push(await bootToOpBegin(m));
    await stopStimd(m);
  }
  results.push(
    `(f) idle restart p95 ${p(idle, 0.95).toFixed(0)} ms (budget ${BUDGETS.idle}); cold start p95 ${p(cold, 0.95).toFixed(0)} ms (budget ${BUDGETS.cold}), of which engine install p95 ${p(install, 0.95).toFixed(0)} ms`,
  );
});

test(
  `(f) cold start p95 within ${BUDGETS.cold} ms and idle restart p95 within ${BUDGETS.idle} ms`,
  { todo: 'design targets for the maintainer machines; hosted runners record them without gating' },
  () => {
    assert.ok(cold.length > 0, 'the timing case measured nothing');
    assert.ok(p(cold, 0.95) <= BUDGETS.cold, `cold start p95 ${p(cold, 0.95).toFixed(0)} ms`);
    assert.ok(p(idle, 0.95) <= BUDGETS.idle, `idle restart p95 ${p(idle, 0.95).toFixed(0)} ms`);
  },
);

test('(b) a 1.42 launchd worker updated through engine.update keeps the build and passes /health', {
  skip: 'needs a published 1.42 and a launchd worker; run on the maintainer machines',
});

test('(c) a 1.42 Windows worker shows the manual update text after its updater rolls back', {
  skip: 'needs a published 1.42 and a Windows worker; run on the maintainer machines',
});
