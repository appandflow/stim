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
import { connect } from 'node:net';
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
    const value = check();
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
    const agents = ['a', 'b'].map((name) => ({
      release: join(tmp, `race-${name}`),
      ...agent(cli, ['revive'], { STIM_E2E_HOLD_UNTIL: join(tmp, `race-${name}`) }),
    }));
    const host = await until('one agent to host stimd', () => record());
    const parent = execFileSync('ps', ['-o', 'ppid=', '-p', String(host.pid)], { encoding: 'utf8' }).trim();
    const owner = agents.find(({ child }) => String(child.pid) === parent);
    const other = agents.find((entry) => entry !== owner);
    assert.ok(owner && other, "the stimd is one agent's child");
    await until('both agents to be admitted and in their command', () =>
      agents.every(({ release }) => existsSync(`${release}.reached`)),
    );
    writeFileSync(owner.release, '');
    await until('the host to wait for the other agent', () =>
      /waiting up to \d+ s for stim revive/.test(owner.stderr()),
    );
    writeFileSync(other.release, '');
    await Promise.all(agents.map(({ closed }) => closed));
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
      /STIM_SANDBOX_BLOCKED: \S+\.sock is outside this sandbox's allowance; run stim doctor --fix, then rerun/,
    );
    assert.equal(record(), null);
  },
);
