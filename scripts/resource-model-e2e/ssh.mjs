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
import { run, shq } from './shell.mjs';

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
    const prepared = await run('ssh', [...SSH_OPTIONS, host, `mkdir -p ${shq(base)}`], { timeoutMs: 60_000 });
    if (prepared.code !== 0) throw new HarnessError(`cannot reach ${host} over ssh: ${prepared.stderr.trim()}`);
    const copied = await run('scp', [...SSH_OPTIONS, archive, `${host}:${base}/payload.tgz`], { timeoutMs: 600_000 });
    if (copied.code !== 0) throw new HarnessError(`scp failed: ${copied.stderr.trim()}`);
    const unpacked = await run(
      'ssh',
      [...SSH_OPTIONS, host, `cd ${shq(base)} && tar xzf payload.tgz && rm payload.tgz`],
      { timeoutMs: 120_000 },
    );
    if (unpacked.code !== 0) throw new HarnessError(`unpacking on ${host} failed: ${unpacked.stderr.trim()}`);

    const args = remoteArguments(opts, { cli: 'stim-tree/node_modules/stim/dist/cli.mjs', out: 'out' });
    const command = `cd ${shq(base)} && command -v node >/dev/null || { echo 'node is not on the PATH of a login shell on this host' >&2; exit 127; }; exec node harness/run.mjs ${args.map(shq).join(' ')}`;
    emit('ssh', `running ${opts.scenario} on ${host}`);
    const code = await new Promise((resolveCode) => {
      const child = spawn('ssh', ['-tt', ...SSH_OPTIONS, host, `exec "$SHELL" -l -c ${shq(command)}`], {
        stdio: 'inherit',
      });
      const hangUp = () => child.kill('SIGHUP');
      for (const name of ['SIGINT', 'SIGTERM']) process.on(name, hangUp);
      child.on('close', (exit) => {
        for (const name of ['SIGINT', 'SIGTERM']) process.off(name, hangUp);
        resolveCode(exit ?? 1);
      });
      child.on('error', () => resolveCode(255));
    });

    mkdirSync(localOut, { recursive: true });
    const fetched = await run('scp', [...SSH_OPTIONS, '-r', `${host}:${base}/out/.`, localOut], { timeoutMs: 600_000 });
    if (fetched.code !== 0)
      throw new HarnessError(
        `could not copy the results back: ${fetched.stderr.trim()}; they remain in ${host}:${base}/out`,
      );
    await run('ssh', [...SSH_OPTIONS, host, `rm -rf ${shq(base)}`], { timeoutMs: 120_000 });
    emit('ssh', `results are in ${localOut}`);
    return code;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
