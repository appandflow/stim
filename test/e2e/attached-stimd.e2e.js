import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { connect, createServer } from 'node:net';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';

const REPO = resolve(import.meta.dirname, '../..');
const PACKAGE = join(REPO, 'packages', 'stim-cli');
const PRELOAD = pathToFileURL(join(import.meta.dirname, 'fixtures', 'block-detached-stimd.mjs')).href;
const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'stim-attached-')));
const store = mkdtempSync(join(PACKAGE, '.e2e-store-'));
let home = join(tmp, 'home');
const project = join(tmp, 'project');
mkdirSync(project);
let env = {
  ...process.env,
  HOME: tmp,
  USERPROFILE: tmp,
  STIM_HOME: home,
  STIM_DAEMON: 'on',
  STIM_DAEMON_ATTACHED_EXIT_WAIT_SECONDS: '2',
  STIM_ENGINE_ROOT: store,
  STIM_NO_UPDATE_CHECK: '1',
};
delete env.CI;
delete env.STIM_TEST_GUARD_NO_HOME_PASSES;

const agents = [];

after(() => {
  for (const child of agents) child.kill('SIGKILL');
  rmSync(tmp, { recursive: true, force: true });
  rmSync(store, { recursive: true, force: true });
});

const record = () => {
  try {
    return JSON.parse(readFileSync(join(home, 'run', 'stimd.json'), 'utf8'));
  } catch {
    return null;
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
const until = async (what, check, ms = 20_000) => {
  for (const deadline = Date.now() + ms; Date.now() < deadline;) {
    const value = await check();
    if (value) return value;
    await new Promise((done) => setTimeout(done, 50));
  }
  assert.fail(`timed out waiting for ${what}`);
};
const daemonLog = () => readFileSync(join(home, 'daemon', 'daemon.ndjson'), 'utf8');

/** An agent's command with the detached start blocked, as a sandbox that kills detached children does. */
function agent(cli, args, extra = {}, preload = PRELOAD) {
  const child = spawn(process.execPath, ['--import', preload, cli, ...args], {
    cwd: project,
    env: { ...env, ...extra },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  agents.push(child);
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += chunk));
  child.stdout.resume();
  const closed = new Promise((done) => child.once('close', (code) => done(code)));
  return { child, closed, stderr: () => stderr };
}

/** Another agent's command in flight on the host, holding its op as a long `stim ios` would. */
function holdOp(build) {
  return new Promise((done, fail) => {
    const socket = connect(record().socket);
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.includes('"op.begun"')) done(socket);
    });
    socket.once('error', fail);
    socket.once('connect', () =>
      socket.write(
        `${JSON.stringify({ kind: 'cli', build })}\n${JSON.stringify({ op: 'op.begin', command: 'stim ios' })}\n`,
      ),
    );
  });
}

/** A second build in the engine store that `current.json` points at: the engine switched under the running host. */
function stageSecondBuild() {
  const id = 'a'.repeat(12);
  cpSync(join(PACKAGE, 'dist'), join(store, id, 'dist'), { recursive: true });
  cpSync(join(PACKAGE, 'package.json'), join(store, id, 'package.json'));
  appendFileSync(join(store, id, 'dist', 'cli.mjs'), '\n');
  writeFileSync(join(store, 'current.json'), JSON.stringify({ format: 1, dir: id, version: 'staged' }));
  return join(store, id, 'dist', 'cli.mjs');
}

test(
  'two agents share an attached stimd, a build switch mid-run ends cleanly, and the next command re-adopts the journal',
  {
    skip: process.platform === 'win32' ? 'the blocked start is simulated with POSIX process groups' : false,
    timeout: 120_000,
  },
  async () => {
    const cli = join(PACKAGE, 'dist', 'cli.mjs');
    const release = join(tmp, 'release-first');
    const first = agent(cli, ['revive'], { STIM_E2E_HOLD_UNTIL: release });

    const host = await until('the first agent to host stimd', () => {
      const bound = record();
      return bound && bound.pid !== first.child.pid ? bound : null;
    });
    assert.equal(
      execFileSync('ps', ['-o', 'ppid=', '-p', String(host.pid)], { encoding: 'utf8' }).trim(),
      String(first.child.pid),
    );

    const second = await holdOp(host.build);
    const status = spawnSync(process.execPath, [join(PACKAGE, 'dist', 'status.mjs'), 'status', '--json'], {
      cwd: project,
      env,
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(status.status, 0, status.stderr);
    assert.ok('ageMs' in JSON.parse(status.stdout), 'the attached stimd answers status');

    const switched = spawnSync(process.execPath, ['--import', PRELOAD, stageSecondBuild(), 'revive'], {
      cwd: project,
      env,
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(switched.status, 1, switched.stderr);
    assert.match(switched.stderr, /STIM_DAEMON_UNAVAILABLE/);
    assert.match(switched.stderr, /separate STIM_HOME/);
    assert.ok(alive(host.pid), 'a command of the new build leaves the attached stimd serving');

    writeFileSync(release, '');
    await first.closed;
    assert.match(first.stderr(), /stimd: waiting up to \d+ s for stim ios to finish/);
    assert.ok(!alive(host.pid), 'the attached stimd exits after its wait');
    assert.match(daemonLog(), /"event":"attached_handover_blocked"/);
    second.destroy();
    const journal = JSON.parse(readFileSync(join(home, 'run', 'stimd-journal.json'), 'utf8'));
    assert.equal(journal.format, 1);
    assert.deepEqual(journal.unfinished, ['stim ios']);

    const third = agent(cli, ['revive']);
    assert.equal(await third.closed, 1, third.stderr());
    assert.ok(!existsSync(join(home, 'run', 'stimd-journal.json')), 'the next host consumed the journal');
    assert.match(daemonLog(), /"event":"stimd_readopted"[^\n]*stim ios still ran/);
    const next = record();
    assert.ok(next === null || !alive(next.pid), 'no stimd outlives the last command');
  },
);

/** A fresh scratch home for one test. */
function useHome(name) {
  home = join(tmp, name);
  env = { ...env, STIM_HOME: home };
}

test(
  'two agents that host at the same moment end up sharing one stimd, which waits for the other',
  {
    skip: process.platform === 'win32' ? 'the blocked start is simulated with POSIX process groups' : false,
    timeout: 120_000,
  },
  async () => {
    useHome('race-home');
    const cli = join(PACKAGE, 'dist', 'cli.mjs');
    const racers = ['a', 'b'].map((name) => {
      const release = join(tmp, `race-${name}`);
      return Object.assign(agent(cli, ['revive'], { STIM_E2E_HOLD_UNTIL: release }), { release });
    });
    const host = await until('one agent to host stimd', () => record());
    const parent = execFileSync('ps', ['-o', 'ppid=', '-p', String(host.pid)], { encoding: 'utf8' }).trim();
    const owner = racers.find(({ child }) => String(child.pid) === parent);
    const other = racers.find((entry) => entry !== owner);
    assert.ok(owner && other, "the stimd is one agent's child");
    await until('both agents to be admitted and in their command', () =>
      racers.every(({ release }) => existsSync(`${release}.reached`)),
    );
    writeFileSync(owner.release, '');
    await until('the host to wait for the other agent', () =>
      /waiting up to \d+ s for stim revive/.test(owner.stderr()),
    );
    writeFileSync(other.release, '');
    await Promise.all(racers.map(({ closed }) => closed));
    assert.ok(!alive(host.pid), 'the stimd exits once both commands ended');
    assert.ok(
      !existsSync(join(home, 'run', 'stimd-journal.json')),
      'nothing was left running, so nothing is journaled',
    );
  },
);

test(
  'a sandbox that denies the stimd socket refuses with STIM_SANDBOX_BLOCKED and leaves no stimd',
  { skip: process.platform === 'win32' ? 'stimd uses a named pipe on Windows' : false, timeout: 60_000 },
  async () => {
    useHome('denied-home');
    const started = Date.now();
    const denied = agent(join(PACKAGE, 'dist', 'cli.mjs'), ['revive'], {}, `${PRELOAD}?deny-socket`);
    assert.equal(await denied.closed, 1);
    assert.ok(Date.now() - started < 10_000, 'the refusal does not wait out the slow-start window');
    assert.match(
      denied.stderr(),
      /STIM_SANDBOX_BLOCKED: \S+\.sock is outside this sandbox's allowance; run Stim outside the sandbox or see stim guide errors sandbox/,
    );
    assert.equal(record(), null);
  },
);

test(
  'failed attached startup releases home and engine claims so the same home can retry',
  { skip: process.platform === 'win32', timeout: 60_000 },
  async () => {
    const scratch = mkdtempSync(join(tmp, 'startup-refusal-'));
    const engineRoot = join(scratch, 'engines');
    const build = 'bbbbbbbbbbbb';
    const selected = join(engineRoot, build);
    const selectedHome = join(scratch, 'home');
    mkdirSync(join(selected, 'dist'), { recursive: true });
    mkdirSync(join(selectedHome, 'run'), { recursive: true });
    cpSync(join(PACKAGE, 'dist'), join(selected, 'dist'), { recursive: true });
    cpSync(join(PACKAGE, 'package.json'), join(selected, 'package.json'));
    symlinkSync(join(PACKAGE, 'node_modules'), join(selected, 'node_modules'), 'junction');
    writeFileSync(join(engineRoot, 'current.json'), JSON.stringify({ format: 1, dir: build, version: 'test' }));
    const cli = join(selected, 'dist', 'cli.mjs');
    const extra = { STIM_HOME: selectedHome, STIM_ENGINE_ROOT: engineRoot };
    const { readClaimSet } = await import(pathToFileURL(join(REPO, 'packages/core/dist/ownership-claim.mjs')).href);
    const clean = () => {
      for (const root of [join(selectedHome, 'run', 'stimd'), join(engineRoot, 'claims', build)]) {
        const survey = readClaimSet(root);
        assert.deepEqual(survey.live, []);
        assert.deepEqual(survey.unresolved, []);
      }
    };
    const retry = async () => {
      const command = agent(cli, ['revive'], extra);
      assert.equal(await command.closed, 1);
      assert.match(command.stderr(), /STIM_NO_PROJECT/);
      clean();
    };
    try {
      const denied = agent(cli, ['revive'], extra, `${PRELOAD}?deny-socket`);
      assert.equal(await denied.closed, 1);
      assert.match(denied.stderr(), /STIM_SANDBOX_BLOCKED/);
      clean();
      await retry();

      const key = join(selectedHome, 'run', 'desktop.key');
      rmSync(key, { force: true });
      mkdirSync(key);
      const failed = agent(cli, ['revive'], extra);
      assert.equal(await failed.closed, 1);
      assert.match(failed.stderr(), /STIM_DAEMON_UNAVAILABLE/);
      clean();
      rmSync(key, { recursive: true, force: true });
      await retry();
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  },
);

test(
  'a failed start waits for another command before its attached stimd exits',
  {
    skip: process.platform === 'win32' ? 'the blocked start is simulated with POSIX process groups' : false,
    timeout: 60_000,
  },
  async () => {
    useHome('failure-home');
    const release = join(tmp, 'release-failure');
    const first = agent(join(PACKAGE, 'dist', 'cli.mjs'), ['start'], { STIM_E2E_HOLD_UNTIL: release });
    const host = await until('the attached stimd', () => record());
    await until('start to reach its failure', () => existsSync(`${release}.reached`));
    const other = await holdOp(host.build);
    writeFileSync(release, '');
    await until('the host to wait for the other command', () =>
      /waiting up to \d+ s for stim ios/.test(first.stderr()),
    );
    other.destroy();
    assert.equal(await first.closed, 1);
    assert.match(first.stderr(), /STIM_NO_PROJECT/);
    assert.ok(!alive(host.pid));
  },
);

for (const selection of ['STIM_HOME', 'HOME']) {
  test(`an attached CI host takes daemon mode from its selected ${selection}`, { timeout: 30_000 }, async () => {
    useHome(`mode-${selection}`);
    if (selection === 'HOME') home = join(tmp, 'home-only', '.stim');
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'config.json'), JSON.stringify({ daemon: { mode: 'off' } }));
    const { hostStimd } = await import(pathToFileURL(join(PACKAGE, 'dist', 'attached-stimd.mjs')).href);
    const ambient = join(tmp, 'ambient-mode-home');
    mkdirSync(ambient, { recursive: true });
    writeFileSync(join(ambient, 'config.json'), JSON.stringify({ daemon: { mode: 'on' } }));
    const previousHome = process.env.STIM_HOME;
    process.env.STIM_HOME = ambient;
    const selected = { ...env };
    delete selected.STIM_DAEMON;
    if (selection === 'HOME') {
      delete selected.STIM_HOME;
      selected.HOME = join(tmp, 'home-only');
      selected.USERPROFILE = selected.HOME;
    }
    let host;
    try {
      host = await hostStimd(selected, { handover: false });
      assert.ok(host && typeof host === 'object');
      const started = await until('selected home daemon', () => record());
      await new Promise((done, reject) => {
        const socket = connect(started.socket);
        socket.once('error', reject);
        socket.once('connect', () =>
          socket.write(`${JSON.stringify({ kind: 'cli', build: started.build })}\n${JSON.stringify({ op: 'tick' })}\n`),
        );
        socket.once('close', done);
        socket.resume();
      });
      assert.equal(existsSync(join(home, 'daemon', 'snapshot.json')), false);
    } finally {
      if (host && typeof host === 'object') await host.end();
      if (previousHome === undefined) delete process.env.STIM_HOME;
      else process.env.STIM_HOME = previousHome;
    }
  });
}

test(
  'attached handover carries non-share listener options',
  { skip: process.platform === 'win32', timeout: 60_000 },
  async () => {
    useHome('listener-home');
    const reservation = createServer().listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const port = reservation.address().port;
    await new Promise((done) => reservation.close(done));
    const release = join(tmp, 'release-listener');
    const first = agent(join(PACKAGE, 'dist', 'cli.mjs'), ['revive'], { STIM_E2E_HOLD_UNTIL: release });
    const started = await until('attached stimd', () => record());
    await until('host command', () => existsSync(`${release}.reached`));
    const answer = await new Promise((done, reject) => {
      const socket = connect(started.socket);
      let buffer = '';
      socket.setEncoding('utf8');
      socket.once('error', reject);
      socket.on('data', (chunk) => {
        buffer += chunk;
        for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
          const reply = JSON.parse(buffer.slice(0, end));
          buffer = buffer.slice(end + 1);
          if (reply.op === 'net') {
            socket.destroy();
            done(reply);
          }
        }
      });
      socket.once('connect', () =>
        socket.write(
          `${JSON.stringify({ kind: 'cli', build: started.build })}\n${JSON.stringify({ op: 'net.ensure', params: { port, loopbackOnly: true } })}\n`,
        ),
      );
    });
    assert.equal(answer.listening, true);
    writeFileSync(join(home, 'config.json'), JSON.stringify({ daemon: { mode: 'off' } }));
    rmSync(join(home, 'daemon', 'snapshot.json'), { force: true });
    writeFileSync(release, '');
    await first.closed;
    const successor = await until('detached successor', () => {
      const next = record();
      return next && next.pid !== started.pid ? next : null;
    });
    try {
      const args = JSON.parse(readFileSync(join(home, 'successor-args.json'), 'utf8'));
      assert.ok(args.includes('--service'));
      assert.ok(args.includes('--carried'));
      assert.ok(args.includes('--loopback-only'));
      assert.equal(args[args.indexOf('--port') + 1], String(port));
      assert.equal(args[args.indexOf('--mode') + 1], 'off');
      await until('successor listener', async () => {
        try {
          return (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) })).status < 600;
        } catch {
          return false;
        }
      });
      await new Promise((done, reject) => {
        const socket = connect(successor.socket);
        socket.once('error', reject);
        socket.once('connect', () =>
          socket.write(
            `${JSON.stringify({ kind: 'cli', build: successor.build })}\n${JSON.stringify({ op: 'tick' })}\n`,
          ),
        );
        socket.once('close', done);
        socket.resume();
      });
      assert.equal(existsSync(join(home, 'daemon', 'snapshot.json')), false);
    } finally {
      process.kill(successor.pid, 'SIGTERM');
      await until('successor to exit', () => !alive(successor.pid));
    }
  },
);

test(
  'a held claim counts as a shared host only after same-build hello',
  { skip: process.platform === 'win32', timeout: 30_000 },
  async () => {
    useHome('held-claim-home');
    const { hostStimd } = await import(pathToFileURL(join(PACKAGE, 'dist', 'attached-stimd.mjs')).href);
    const { tryAcquireClaim, releaseClaim } = await import(
      pathToFileURL(join(REPO, 'packages/core/dist/ownership-claim.mjs')).href
    );
    const held = tryAcquireClaim({ root: join(home, 'run', 'stimd'), mode: 'exclusive', label: 'stimd' }).acquired;
    assert.ok(held);
    try {
      assert.equal((await hostStimd(env, { handover: false }))?.refusal?.code, 'STIM_DAEMON_UNAVAILABLE');
      const module = pathToFileURL(join(PACKAGE, 'dist', 'attached-stimd.mjs')).href;
      const denied = spawnSync(
        process.execPath,
        [
          '--import',
          `${PRELOAD}?deny-connect`,
          '--input-type=module',
          '-e',
          `import { hostStimd } from ${JSON.stringify(module)}; console.log(JSON.stringify(await hostStimd(process.env, { handover: false })));`,
        ],
        { env, encoding: 'utf8', timeout: 15_000 },
      );
      assert.equal(denied.status, 0, denied.stderr);
      assert.equal(JSON.parse(denied.stdout), 'blocked');
    } finally {
      releaseClaim(held);
    }
    const first = await hostStimd(env, { handover: false });
    assert.ok(first && typeof first === 'object');
    try {
      assert.equal(await hostStimd(env, { handover: false }), 'held-attached');
    } finally {
      await first.end();
    }
  },
);

test(
  'a synchronous detached spawn denial falls back to an attached daemon',
  { skip: process.platform === 'win32', timeout: 30_000 },
  async () => {
    useHome('throw-detached-home');
    const release = join(tmp, 'release-throw-detached');
    const first = agent(
      join(PACKAGE, 'dist', 'cli.mjs'),
      ['revive'],
      { STIM_E2E_HOLD_UNTIL: release },
      `${PRELOAD}?throw-detached`,
    );
    const host = await until('the attached daemon', () => record());
    await until('the command to start', () => existsSync(`${release}.reached`));
    assert.equal(
      execFileSync('ps', ['-o', 'ppid=', '-p', String(host.pid)], { encoding: 'utf8' }).trim(),
      String(first.child.pid),
    );
    const other = await holdOp(host.build);
    writeFileSync(release, '');
    assert.equal(await first.closed, 1);
    other.destroy();
    assert.match(first.stderr(), /STIM_NO_PROJECT/);
    assert.equal(alive(host.pid), false);
    assert.match(daemonLog(), /"event":"attached_handover_blocked"/);
  },
);

test(
  'attached stimd bounds shutdown after its parent closes stdin with stalled maintenance',
  { timeout: 30_000 },
  async () => {
    const scratch = mkdtempSync(join(tmp, 'watchdog-'));
    const marker = join(scratch, 'passes-started');
    const preload = pathToFileURL(join(import.meta.dirname, 'fixtures', 'stall-stimd-passes.mjs')).href;
    const cli = join(PACKAGE, 'dist', 'cli.mjs');
    const child = spawn(process.execPath, ['--import', preload, cli, '__stimd', '--attached', '--no-handover'], {
      cwd: project,
      env: {
        ...env,
        STIM_HOME: scratch,
        STIM_DAEMON_ATTACHED_EXIT_WAIT_SECONDS: '0',
        STIM_TEST_STALLED_PASSES: marker,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    agents.push(child);
    child.stdout.resume();
    child.stderr.resume();
    const exited = new Promise((done) => child.once('exit', (code) => done(code)));
    try {
      const info = await until('attached daemon', () => {
        try {
          return JSON.parse(readFileSync(join(scratch, 'run', 'stimd.json'), 'utf8'));
        } catch {
          return null;
        }
      });
      const socket = connect(info.socket);
      socket.on('error', () => {});
      socket.on('connect', () =>
        socket.write(`${JSON.stringify({ kind: 'cli', build: info.build })}\n${JSON.stringify({ op: 'tick' })}\n`),
      );
      await until('maintenance to stall', () => existsSync(marker));
      socket.destroy();
      child.stdin.end();
      assert.equal(await exited, 1);
    } finally {
      child.kill('SIGKILL');
      rmSync(scratch, { recursive: true, force: true });
    }
  },
);

test('an installed CI caller shares the selected engine daemon of another build', { timeout: 30_000 }, async () => {
  const scratch = mkdtempSync(join(tmp, 'engine-routing-'));
  const engineRoot = join(scratch, 'engines');
  const selected = join(engineRoot, 'bbbbbbbbbbbb');
  const installed = join(scratch, 'node_modules', 'stim');
  mkdirSync(join(installed, 'dist'), { recursive: true });
  mkdirSync(join(selected, 'dist'), { recursive: true });
  cpSync(join(PACKAGE, 'dist'), join(installed, 'dist'), { recursive: true });
  cpSync(join(PACKAGE, 'dist'), join(selected, 'dist'), { recursive: true });
  for (const dir of [selected, installed]) {
    symlinkSync(join(PACKAGE, 'node_modules'), join(dir, 'node_modules'), 'junction');
    cpSync(join(PACKAGE, 'package.json'), join(dir, 'package.json'));
  }
  appendFileSync(join(selected, 'dist', 'cli.mjs'), '\n');
  writeFileSync(join(engineRoot, 'current.json'), JSON.stringify({ format: 1, dir: 'bbbbbbbbbbbb', version: 'test' }));
  const chosenEnv = { ...env, STIM_HOME: join(scratch, 'home'), STIM_ENGINE_ROOT: engineRoot };
  const { workspaceName } = await import(pathToFileURL(join(REPO, 'packages/core/dist/index.mjs')).href);
  const workspaceDir = join(chosenEnv.STIM_HOME, 'workspaces', workspaceName(project));
  mkdirSync(workspaceDir, { recursive: true });
  writeFileSync(
    join(chosenEnv.STIM_HOME, 'config.json'),
    JSON.stringify({ version: 2, projects: { [project]: {} }, repos: {} }),
  );
  writeFileSync(join(workspaceDir, 'state.json'), JSON.stringify({ supervisor: { engineDir: 'aaaaaaaaaaaa' } }));
  const previousRoot = process.env.STIM_ENGINE_ROOT;
  process.env.STIM_ENGINE_ROOT = engineRoot;
  let owner;
  let binding;
  let direct;
  try {
    const engine = await import(pathToFileURL(join(selected, 'dist', 'attached-stimd.mjs')).href);
    owner = await engine.hostStimd(chosenEnv, { handover: false });
    assert.equal(typeof owner, 'object');
    assert.ok(owner);
    const claimRoot = join(engineRoot, 'claims', 'bbbbbbbbbbbb', 'shared');
    const claims = () => readdirSync(claimRoot).filter((name) => name.endsWith('.claim')).length;
    assert.equal(claims(), 1);
    const residentClaim = JSON.parse(
      readFileSync(
        join(
          claimRoot,
          readdirSync(claimRoot).find((name) => name.endsWith('.claim')),
        ),
        'utf8',
      ),
    );
    assert.deepEqual(residentClaim.details.engineDirs, ['aaaaaaaaaaaa']);
    direct = await engine.bindCIEngine(chosenEnv);
    assert.equal(claims(), 2);
    const caller = await import(pathToFileURL(join(installed, 'dist', 'attached-stimd.mjs')).href);
    binding = await caller.bindCIEngine(chosenEnv);
    assert.equal(claims(), 3);
    assert.equal(await binding.host(chosenEnv, { handover: false }), 'held-attached');
    binding.release();
    binding = null;
    direct.release();
    direct = null;
    assert.equal(claims(), 1);
    writeFileSync(
      join(engineRoot, 'current.json'),
      JSON.stringify({ format: 1, dir: 'cccccccccccc', version: 'next' }),
    );
    await assert.rejects(engine.bindCIEngine(chosenEnv), { code: 'STIM_ENGINE_SWITCHED' });
    assert.deepEqual(await engine.hostStimd({ ...chosenEnv, STIM_HOME: join(scratch, 'stale-home') }), {
      switched: 'next',
    });
    assert.equal(claims(), 1);
    rmSync(join(engineRoot, 'current.json'));
    await assert.rejects(engine.bindCIEngine(chosenEnv), { code: 'STIM_ENGINE_UNAVAILABLE' });
    assert.equal(
      await engine.hostStimd({ ...chosenEnv, STIM_HOME: join(scratch, 'missing-pointer-home') }),
      'engine-unavailable',
    );
    assert.equal(claims(), 1);
    writeFileSync(
      join(engineRoot, 'current.json'),
      JSON.stringify({ format: 1, dir: 'bbbbbbbbbbbb', version: 'test' }),
    );
    const daemon = JSON.parse(readFileSync(join(chosenEnv.STIM_HOME, 'run', 'stimd.json'), 'utf8'));
    rmSync(
      join(
        claimRoot,
        readdirSync(claimRoot).find((name) => name.endsWith('.claim')),
      ),
    );
    const tick = connect(daemon.socket);
    tick.on('error', () => {});
    tick.on('connect', () =>
      tick.write(`${JSON.stringify({ kind: 'cli', build: daemon.build })}\n${JSON.stringify({ op: 'tick' })}\n`),
    );
    await until(
      'daemon to stop after its claim is lost',
      () => !existsSync(join(chosenEnv.STIM_HOME, 'run', 'stimd.json')),
    );
    tick.destroy();
    await assert.rejects(owner.end(), /Attached stimd exited/);
    owner = null;
    const blockedClaims = join(engineRoot, 'claims', 'bbbbbbbbbbbb');
    rmSync(blockedClaims, { recursive: true, force: true });
    writeFileSync(blockedClaims, 'blocking file');
    const refused = await engine.hostStimd({ ...chosenEnv, STIM_HOME: join(scratch, 'claim-refusal-home') });
    assert.equal(refused?.refusal?.code, 'STIM_CLAIM_REFUSED');
    assert.match(refused.refusal.message, /claim/);
    assert.match(refused.refusal.remedy, /retry/);
  } finally {
    if (owner && typeof owner === 'object') await owner.end();
    binding?.release();
    direct?.release();
    if (previousRoot === undefined) delete process.env.STIM_ENGINE_ROOT;
    else process.env.STIM_ENGINE_ROOT = previousRoot;
    rmSync(scratch, { recursive: true, force: true });
  }
});

test(
  'an attached store daemon reports a denied engine lock',
  { timeout: 30_000, skip: process.platform === 'win32' },
  async () => {
    const scratch = mkdtempSync(join(tmp, 'denied-engine-lock-'));
    const engineRoot = join(scratch, 'engines');
    const selected = join(engineRoot, 'bbbbbbbbbbbb');
    mkdirSync(join(selected, 'dist'), { recursive: true });
    cpSync(join(PACKAGE, 'dist'), join(selected, 'dist'), { recursive: true });
    cpSync(join(PACKAGE, 'package.json'), join(selected, 'package.json'));
    symlinkSync(join(PACKAGE, 'node_modules'), join(selected, 'node_modules'), 'junction');
    const raw = join(realpathSync(engineRoot), '.lock.sock');
    const hash = createHash('sha256').update(raw).digest('hex');
    const lock =
      Buffer.byteLength(raw) <= (process.platform === 'linux' ? 107 : 103)
        ? raw
        : join('/tmp', `stim-sockets-${process.getuid()}`, `${hash}.sock`);
    const preload = pathToFileURL(join(import.meta.dirname, 'fixtures', 'deny-engine-lock.mjs')).href;
    const previousRoot = process.env.STIM_ENGINE_ROOT;
    process.env.STIM_ENGINE_ROOT = engineRoot;
    try {
      const child = spawn(
        process.execPath,
        ['--import', preload, join(selected, 'dist', 'cli.mjs'), '__stimd', '--attached'],
        {
          env: { ...env, STIM_HOME: join(scratch, 'home'), STIM_ENGINE_ROOT: engineRoot, STIM_TEST_ENGINE_LOCK: lock },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      agents.push(child);
      let output = '';
      child.stdout.on('data', (chunk) => (output += chunk));
      child.stderr.resume();
      const [code] = await once(child, 'exit');
      assert.equal(code, 77);
      assert.match(output, /attached-blocked-lock/);
      assert.equal(existsSync(join(scratch, 'home', 'run', 'stimd.json')), false);
    } finally {
      if (previousRoot === undefined) delete process.env.STIM_ENGINE_ROOT;
      else process.env.STIM_ENGINE_ROOT = previousRoot;
      rmSync(scratch, { recursive: true, force: true });
    }
  },
);

test('host end reports an attached daemon killed before shutdown', { timeout: 30_000 }, async () => {
  const scratch = mkdtempSync(join(tmp, 'killed-host-'));
  let host;
  try {
    const module = await import(pathToFileURL(join(PACKAGE, 'dist', 'attached-stimd.mjs')).href);
    host = await module.hostStimd({ ...env, STIM_HOME: scratch }, { handover: false });
    assert.ok(host && typeof host === 'object');
    const info = JSON.parse(readFileSync(join(scratch, 'run', 'stimd.json'), 'utf8'));
    const hostEnv = { ...env, STIM_HOME: scratch };
    await assert.rejects(module.holdCIStimd(hostEnv, project, 'another-instance'));
    const release = await module.holdCIStimd(hostEnv, project, host.instance);
    release();
    process.kill(info.pid, 'SIGKILL');
    await assert.rejects(host.end(), /Attached stimd exited/);
    host = null;
  } finally {
    if (host && typeof host === 'object') await host.end().catch(() => {});
    rmSync(scratch, { recursive: true, force: true });
  }
});

test(
  'a host forced to kill an unresponsive attached daemon leaves home and engine claims unresolved',
  { timeout: 30_000, skip: process.platform === 'win32' },
  async () => {
    const scratch = mkdtempSync(join(tmp, 'stalled-host-'));
    const engineRoot = join(scratch, 'engines');
    const build = 'bbbbbbbbbbbb';
    const selected = join(engineRoot, build);
    mkdirSync(join(selected, 'dist'), { recursive: true });
    cpSync(join(PACKAGE, 'dist'), join(selected, 'dist'), { recursive: true });
    symlinkSync(join(PACKAGE, 'node_modules'), join(selected, 'node_modules'), 'junction');
    cpSync(join(PACKAGE, 'package.json'), join(selected, 'package.json'));
    writeFileSync(join(engineRoot, 'current.json'), JSON.stringify({ format: 1, dir: build, version: 'test' }));
    const selectedHome = join(scratch, 'home');
    const selectedEnv = {
      ...env,
      STIM_HOME: selectedHome,
      STIM_ENGINE_ROOT: engineRoot,
      STIM_DAEMON_ATTACHED_EXIT_WAIT_SECONDS: '0',
    };
    const previousRoot = process.env.STIM_ENGINE_ROOT;
    process.env.STIM_ENGINE_ROOT = engineRoot;
    let host;
    let pid;
    try {
      const engine = await import(pathToFileURL(join(selected, 'dist', 'attached-stimd.mjs')).href);
      const { readClaimSet } = await import(pathToFileURL(join(REPO, 'packages/core/dist/ownership-claim.mjs')).href);
      host = await engine.hostStimd(selectedEnv, { handover: false });
      assert.ok(host && typeof host === 'object' && 'end' in host);
      pid = JSON.parse(readFileSync(join(selectedHome, 'run', 'stimd.json'), 'utf8')).pid;
      process.kill(pid, 'SIGSTOP');
      await assert.rejects(host.end(), /Attached stimd exited/);
      host = null;
      assert.equal(readClaimSet(join(selectedHome, 'run', 'stimd')).unresolved.length, 1);
      assert.equal(readClaimSet(join(engineRoot, 'claims', build)).unresolved.length, 1);
    } finally {
      if (pid && alive(pid)) process.kill(pid, 'SIGKILL');
      if (host && typeof host === 'object' && 'end' in host) await host.end().catch(() => {});
      if (previousRoot === undefined) delete process.env.STIM_ENGINE_ROOT;
      else process.env.STIM_ENGINE_ROOT = previousRoot;
      rmSync(scratch, { recursive: true, force: true });
    }
  },
);

test(
  'store lock contention refuses before startup and the same home can retry',
  { timeout: 25_000, skip: process.platform === 'win32' },
  async () => {
    const scratch = realpathSync(mkdtempSync('/tmp/stim-lock-'));
    const engineRoot = join(scratch, 'engines');
    const selected = join(engineRoot, 'bbbbbbbbbbbb');
    mkdirSync(join(selected, 'dist'), { recursive: true });
    cpSync(join(PACKAGE, 'dist'), join(selected, 'dist'), { recursive: true });
    cpSync(join(PACKAGE, 'package.json'), join(selected, 'package.json'));
    symlinkSync(join(PACKAGE, 'node_modules'), join(selected, 'node_modules'), 'junction');
    writeFileSync(
      join(engineRoot, 'current.json'),
      JSON.stringify({ format: 1, dir: 'bbbbbbbbbbbb', version: 'test' }),
    );
    const lock = createServer();
    await new Promise((done, fail) =>
      lock.once('error', fail).listen(join(realpathSync(engineRoot), '.lock.sock'), done),
    );
    const previousRoot = process.env.STIM_ENGINE_ROOT;
    process.env.STIM_ENGINE_ROOT = engineRoot;
    let lockClosed = false;
    try {
      const engine = await import(pathToFileURL(join(selected, 'dist', 'attached-stimd.mjs')).href);
      const sharedHome = join(scratch, 'home');
      const host = engine.hostStimd({ ...env, STIM_HOME: sharedHome, STIM_ENGINE_ROOT: engineRoot });
      const on = agent(join(selected, 'dist', 'cli.mjs'), ['revive'], {
        STIM_HOME: sharedHome,
        STIM_ENGINE_ROOT: engineRoot,
        STIM_DAEMON: 'on',
      });
      const off = agent(join(selected, 'dist', 'cli.mjs'), ['revive'], {
        STIM_HOME: sharedHome,
        STIM_ENGINE_ROOT: engineRoot,
        STIM_DAEMON: 'off',
      });
      assert.notEqual(await on.closed, 0);
      assert.notEqual(await off.closed, 0);
      assert.match(on.stderr(), /STIM_DAEMON_UNAVAILABLE/);
      assert.match(off.stderr(), /STIM_NO_PROJECT/);
      const result = await host;
      assert.equal(result?.refusal?.code, 'STIM_DAEMON_UNAVAILABLE');
      assert.equal(existsSync(join(sharedHome, 'run', 'stimd.json')), false);
      const { readClaimSet } = await import(pathToFileURL(join(REPO, 'packages/core/dist/ownership-claim.mjs')).href);
      assert.deepEqual(readClaimSet(join(sharedHome, 'run', 'stimd')).unresolved, []);
      await new Promise((done) => lock.close(done));
      lockClosed = true;
      const retry = await engine.hostStimd({ ...env, STIM_HOME: sharedHome, STIM_ENGINE_ROOT: engineRoot });
      assert.ok(retry && typeof retry === 'object' && 'end' in retry);
      await retry.end();
      assert.deepEqual(readClaimSet(join(sharedHome, 'run', 'stimd')).unresolved, []);
    } finally {
      if (!lockClosed) await new Promise((done) => lock.close(done));
      if (previousRoot === undefined) delete process.env.STIM_ENGINE_ROOT;
      else process.env.STIM_ENGINE_ROOT = previousRoot;
      rmSync(scratch, { recursive: true, force: true });
    }
  },
);
