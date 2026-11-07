import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
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
    assert.match(switched.stderr, /STIM_NO_PROJECT/);
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
      assert.equal(await hostStimd(env, { handover: false }), null);
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
      assert.equal(await hostStimd(env, { handover: false }), 'held');
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
    writeFileSync(release, '');
    assert.equal(await first.closed, 1);
    assert.match(first.stderr(), /STIM_NO_PROJECT/);
    assert.equal(alive(host.pid), false);
  },
);
