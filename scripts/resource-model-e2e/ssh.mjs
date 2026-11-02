import { spawn } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HarnessError } from './workspaces.mjs';
import { run, shq, sleep } from './shell.mjs';

const HARNESS_DIR = dirname(fileURLToPath(import.meta.url));
const SSH_OPTIONS = ['-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=6', '-o', 'BatchMode=yes'];

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function workspaceClosure(root, start, read = readJson, list = readdirSync) {
  const byName = new Map();
  for (const entry of list(join(root, 'packages'))) {
    try {
      const manifest = read(join(root, 'packages', entry, 'package.json'));
      byName.set(manifest.name, { dir: join(root, 'packages', entry), manifest });
    } catch {}
  }
  const found = new Map();
  const visit = (name) => {
    if (found.has(name)) return;
    const entry = byName.get(name);
    if (!entry) throw new HarnessError(`workspace package ${name} not found under ${join(root, 'packages')}`);
    found.set(name, entry.dir);
    const deps = { ...entry.manifest.dependencies, ...entry.manifest.optionalDependencies };
    for (const [dep, range] of Object.entries(deps)) if (String(range).startsWith('workspace:')) visit(dep);
  };
  visit(start);
  return [...found.values()];
}

function packagesFor(cli) {
  let packageDir = dirname(realpathSync(cli));
  while (!existsSync(join(packageDir, 'package.json'))) packageDir = dirname(packageDir);
  return workspaceClosure(dirname(dirname(packageDir)), readJson(join(packageDir, 'package.json')).name);
}

async function assembleStimTree(cli, scratch, emit) {
  const dirs = packagesFor(cli);
  const tgz = join(scratch, 'tgz');
  const tree = join(scratch, 'stim-tree');
  mkdirSync(tgz, { recursive: true });
  mkdirSync(tree, { recursive: true });
  writeFileSync(join(tree, 'package.json'), '{"name":"stim-e2e-tree","private":true}\n');
  for (const dir of dirs) {
    const packed = await run('pnpm', ['pack', '--pack-destination', tgz], { cwd: dir, timeoutMs: 120_000 });
    if (packed.code !== 0) throw new HarnessError(`pnpm pack failed in ${dir}: ${packed.stderr.trim().slice(-300)}`);
  }
  const files = readdirSync(tgz).map((name) => join(tgz, name));
  emit(
    'ssh',
    `installing ${files.length} packed packages into one tree (needs the npm registry for third-party dependencies)`,
  );
  const installed = await run('npm', ['install', '--no-audit', '--no-fund', '--no-package-lock', ...files], {
    cwd: tree,
    timeoutMs: 600_000,
  });
  if (installed.code !== 0)
    throw new HarnessError(`npm install of the packed stim failed: ${installed.stderr.trim().slice(-300)}`);
  return tree;
}

export function remoteArguments(opts, remote) {
  const args = [
    '--scenario',
    opts.scenario,
    '--target',
    'local',
    '--project',
    opts.project,
    '--stim',
    remote.cli,
    '--out',
    remote.out,
    '--workspaces',
    String(opts.workspaces),
    '--max-load',
    String(opts.maxLoad),
  ];
  if (opts.idleMinutes !== null) args.push('--idle-minutes', String(opts.idleMinutes));
  if (opts.dormantMinutes !== null) args.push('--dormant-minutes', String(opts.dormantMinutes));
  if (opts.homeDir) args.push('--home-dir', opts.homeDir);
  if (opts.workDir) args.push('--work-dir', opts.workDir);
  for (const [key, value] of Object.entries(opts.extraEnv)) args.push('--env', `${key}=${value}`);
  return args;
}

const TEARDOWN_WAIT_MS = 20 * 60_000;
const hostShell = (command) => `exec "$SHELL" -l -c ${shq(command)}`;
const onHost = (host, command, timeoutMs) => run('ssh', [...SSH_OPTIONS, host, hostShell(command)], { timeoutMs });

const RECONNECT_WAIT_MS = 10 * 60_000;

async function followRun(host, base, state, emit) {
  const dir = shq(base);
  for (let attach = 0; !state.giveUp; attach++) {
    const watch = `cd ${dir} && { tail -n ${attach === 0 ? '+1' : '20'} -f run.log & T=$!; while kill -0 $(cat run.pid) 2>/dev/null; do sleep 2; done; sleep 2; kill $T; }`;
    await new Promise((resolveClosed) => {
      state.child = spawn('ssh', [...SSH_OPTIONS, host, hostShell(watch)], { stdio: 'inherit' });
      state.child.on('close', resolveClosed);
      state.child.on('error', resolveClosed);
    });
    let unreachableSince = null;
    let alive = await onHost(host, `kill -0 $(cat ${dir}/run.pid) 2>/dev/null`, 60_000);
    while (alive.code === 255 && !state.giveUp) {
      unreachableSince ??= Date.now();
      if (Date.now() - unreachableSince > RECONNECT_WAIT_MS) {
        emit('ssh', `${host} has been unreachable for ${RECONNECT_WAIT_MS / 60_000} minutes; the run continues there`);
        return;
      }
      emit('ssh', 'the host is unreachable; retrying');
      await sleep(10_000);
      alive = await onHost(host, `kill -0 $(cat ${dir}/run.pid) 2>/dev/null`, 60_000);
    }
    if (alive.code !== 0 || state.giveUp) return;
    emit('ssh', 'the connection dropped while the run is still going; reattaching');
    await sleep(5000);
  }
}

export async function runRemote(opts, { runId, localOut, emit }) {
  const host = opts.target.slice('ssh:'.length);
  const scratch = mkdtempSync(join(tmpdir(), 'rm-e2e-ssh-'));
  const base = `rm-e2e/${runId}-remote`;
  try {
    emit('ssh', `assembling the stim package from ${opts.stim}`);
    const tree = await assembleStimTree(resolve(opts.stim), scratch, emit);
    const payload = join(scratch, 'payload');
    mkdirSync(payload, { recursive: true });
    cpSync(HARNESS_DIR, join(payload, 'harness'), { recursive: true, filter: (path) => !path.endsWith('.test.mjs') });
    cpSync(tree, join(payload, 'stim-tree'), { recursive: true });
    const archive = join(scratch, 'payload.tgz');
    const tarred = await run('tar', ['czf', archive, '-C', payload, '.']);
    if (tarred.code !== 0) throw new HarnessError(`tar failed: ${tarred.stderr}`);

    emit('ssh', `copying ${base} to ${host}`);
    const prepared = await onHost(host, `if [ -d rm-e2e ]; then echo existed; fi; mkdir -p ${shq(base)}`, 60_000);
    if (prepared.code !== 0) throw new HarnessError(`cannot reach ${host} over ssh: ${prepared.stderr.trim()}`);
    const rootExisted = prepared.stdout.includes('existed');
    const copied = await run('scp', [...SSH_OPTIONS, archive, `${host}:${base}/payload.tgz`], { timeoutMs: 600_000 });
    if (copied.code !== 0) throw new HarnessError(`scp failed: ${copied.stderr.trim()}`);
    const unpacked = await run(
      'ssh',
      [...SSH_OPTIONS, host, `cd ${shq(base)} && tar xzf payload.tgz && rm payload.tgz`],
      { timeoutMs: 120_000 },
    );
    if (unpacked.code !== 0) throw new HarnessError(`unpacking on ${host} failed: ${unpacked.stderr.trim()}`);

    const args = remoteArguments(opts, { cli: 'stim-tree/node_modules/stim/dist/cli.mjs', out: 'out' });
    const state = { interrupted: false, giveUp: false, child: null };
    const inner = `node harness/run.mjs ${args.map(shq).join(' ')} & echo $! > run.pid; wait $!; echo $? > run.code`;
    const start = `cd ${shq(base)} && { command -v node >/dev/null || { echo 'node is not on the PATH of a login shell on this host' >&2; exit 127; }; } && : > run.log && { nohup sh -c ${shq(inner)} > run.log 2>&1 < /dev/null 3>&- 4>&- 5>&- 6>&- 7>&- 8>&- 9>&- & }`;
    emit('ssh', `starting ${opts.scenario} on ${host}, detached so a lost connection does not stop it`);
    const started = await onHost(host, start, 60_000);
    if (started.code !== 0 || started.timedOut) {
      throw new HarnessError(
        `could not start the run on ${host} (${started.timedOut ? 'the ssh command did not return' : started.stderr.trim()}); check ${base} on the host and remove it with: ssh ${host} rm -rf ${shq(base)}`,
      );
    }

    const interrupt = async () => {
      if (state.interrupted) {
        state.giveUp = true;
        state.child?.kill('SIGHUP');
        return;
      }
      state.interrupted = true;
      emit(
        'ssh',
        'interrupted: asking the remote harness to tear down, and waiting for it (interrupt again to stop waiting)',
      );
      const dir = shq(base);
      const ask = `cd ${dir} && { test -f run.code || { pid=$(cat run.pid); case "$(ps -ww -o command= -p $pid)" in *harness/run.mjs*) kill -INT $pid ;; esac; }; }`;
      await onHost(host, ask, 60_000);
      setTimeout(() => {
        state.giveUp = true;
        state.child?.kill('SIGHUP');
      }, TEARDOWN_WAIT_MS).unref();
    };
    const handlers = ['SIGINT', 'SIGTERM'];
    for (const name of handlers) process.on(name, interrupt);
    try {
      await followRun(host, base, state, emit);
    } finally {
      for (const name of handlers) process.off(name, interrupt);
    }

    mkdirSync(localOut, { recursive: true });
    const fetched = await run('scp', [...SSH_OPTIONS, '-r', `${host}:${base}/out/.`, localOut], { timeoutMs: 600_000 });
    if (fetched.code !== 0) emit('ssh', `could not copy the results back: ${fetched.stderr.trim()}`);
    const finished = await onHost(host, `cat ${shq(base)}/run.code`, 60_000);
    const code = finished.code === 0 ? Number(finished.stdout.trim()) : null;
    if (code === null || fetched.code !== 0) {
      emit(
        'ssh',
        `the run directory ${host}:${base} is left in place (${code === null ? 'the remote harness has not finished' : 'the results were not copied'}); remove it with: ssh ${host} rm -rf ${shq(base)}`,
      );
      return state.interrupted ? 130 : 2;
    }
    await onHost(host, `rm -rf ${shq(base)}${rootExisted ? '' : '; rmdir rm-e2e 2>/dev/null; true'}`, 120_000);
    emit('ssh', `results are in ${localOut}`);
    return code;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
