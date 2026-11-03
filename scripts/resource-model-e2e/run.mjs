#!/usr/bin/env node
import { spawn } from 'node:child_process';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { derivedDeviceCap } from './analysis.mjs';
import { UsageError, parseArgs } from './args.mjs';
import { createAssertions, STATUS } from './assertions.mjs';
import { collectEvidence } from './collect.mjs';
import { readMachine, readSimulators, parseCsv } from './platform.mjs';
import { renderReport } from './report.mjs';
import { run as runCommand, sleep } from './shell.mjs';
import { runCheck } from './scenarios/check.mjs';
import { runDisk } from './scenarios/disk.mjs';
import { runNormal } from './scenarios/normal.mjs';
import { runStress } from './scenarios/stress.mjs';
import { runRemote } from './ssh.mjs';
import { createStim } from './stim.mjs';
import { describeVolume, mismatchedVolumes, volumeLine } from './volumes.mjs';
import { HarnessError, podEnvironment, teardown, trackLedger } from './workspaces.mjs';

// A closed terminal or ssh session makes writes fail with EIO; teardown must not depend on them.
for (const stream of [process.stdout, process.stderr]) stream.on('error', () => {});

const SCENARIOS = { normal: runNormal, disk: runDisk, stress: runStress, check: runCheck };
const SAMPLE_INTERVAL_SEC = 5;
const STATUS_EVERY_MS = 30_000;
const HERE = dirname(fileURLToPath(import.meta.url));

const mmss = (ms) =>
  `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);

function createContext(opts, runId) {
  const scratch = join(homedir(), 'rm-e2e');
  const homeDir = resolve(opts.homeDir ?? scratch);
  const workDir = resolve(opts.workDir ?? scratch);
  const out = resolve(opts.out ?? join('rm-e2e-out', `${stamp()}-${runId}`));
  const abort = new AbortController();
  const startedAt = Date.now();
  const events = [];
  const records = new Map();
  const ctx = {
    opts,
    runId,
    out,
    homeDir,
    workDir,
    home: join(homeDir, `${runId}-home`),
    ballastDir: join(homeDir, `${runId}-ballast`),
    project: realpathSync(resolve(opts.project)),
    worktreePrefix: join(workDir, runId),
    startedAt,
    events,
    workspaces: [],
    snapshots: [],
    createdUdids: new Set(),
    identities: new Map(),
    recordedAt: new Map(),
    createdDirs: [],
    cleanups: [],
    signal: abort.signal,
    abort: () => abort.abort(),
    assertions: createAssertions(),
    sampleIntervalSec: SAMPLE_INTERVAL_SEC,
    record(workspace) {
      if (!records.has(workspace.label)) records.set(workspace.label, {});
      return records.get(workspace.label);
    },
    emit(kind, msg) {
      const event = { t: Date.now(), kind, msg };
      events.push(event);
      try {
        appendFileSync(join(ctx.out, 'events.ndjson'), `${JSON.stringify(event)}\n`);
        console.log(`[${mmss(event.t - startedAt)}] ${kind}: ${msg}`);
      } catch {}
    },
    setStage(name) {
      try {
        writeFileSync(join(ctx.out, 'stage'), name);
      } catch {}
      ctx.emit('stage', name);
    },
    logFile(name, text) {
      writeFileSync(join(ctx.out, name), text);
    },
    trackLedger: () => trackLedger(ctx),
  };
  return ctx;
}

function ensureDir(ctx, dir) {
  const first = mkdirSync(dir, { recursive: true });
  if (first) ctx.createdDirs.push(first);
}

const inside = (path, root) => path === root || path.startsWith(`${root}/`);

function physical(path) {
  let current = resolve(path);
  const tail = [];
  while (!existsSync(current)) {
    tail.unshift(basename(current));
    current = dirname(current);
  }
  return join(realpathSync(current), ...tail);
}

function realStimRoots() {
  const realStim = join(homedir(), '.stim');
  return [realStim, ...(existsSync(realStim) ? [realpathSync(realStim)] : [])];
}

function guardPaths(ctx) {
  const guarded = [ctx.homeDir, ctx.workDir, ctx.out, ctx.home, ctx.ballastDir];
  for (const candidate of guarded) {
    if (realStimRoots().some((root) => inside(resolve(candidate), root) || inside(physical(candidate), root))) {
      throw new UsageError(
        `${candidate} is inside the real stim home ${join(homedir(), '.stim')}; the harness only runs under a private home it creates`,
      );
    }
  }
}

function guardEnv(extraEnv) {
  for (const [key, value] of Object.entries(extraEnv)) {
    if (key === 'STIM_HOME')
      throw new UsageError('--env cannot set STIM_HOME: every command runs under the private home');
    if (value.includes('/') && realStimRoots().some((root) => inside(resolve(value), root))) {
      throw new UsageError(`--env ${key} points into the real stim home, which the harness never touches`);
    }
  }
}

function settlePaths(ctx) {
  ctx.homeDir = realpathSync(ctx.homeDir);
  ctx.workDir = realpathSync(ctx.workDir);
  ctx.out = realpathSync(ctx.out);
  ctx.home = join(ctx.homeDir, `${ctx.runId}-home`);
  ctx.ballastDir = join(ctx.homeDir, `${ctx.runId}-ballast`);
  ctx.worktreePrefix = join(ctx.workDir, ctx.runId);
  guardPaths(ctx);
}

async function reportVolumes(ctx) {
  const simulators = join(homedir(), 'Library', 'Developer', 'CoreSimulator', 'Devices');
  ctx.volumes = {
    project: await describeVolume(ctx.project),
    home: await describeVolume(ctx.homeDir),
    work: await describeVolume(ctx.workDir),
    ...(ctx.opts.scenario === 'disk' ? { ballast: await describeVolume(ctx.homeDir) } : {}),
  };
  const sims = await describeVolume(simulators);
  console.log(volumeLine('simulators (always the internal disk)', sims));
  for (const [name, volume] of Object.entries(ctx.volumes)) console.log(volumeLine(name, volume));
  ctx.simulatorsPath = simulators;
  if (ctx.opts.scenario === 'disk') {
    const mismatched = mismatchedVolumes(ctx.volumes);
    if (mismatched.length) {
      throw new UsageError(
        `the disk scenario needs the project, the private home, the worktrees and the ballast on one volume so the pressure levels trigger; ${mismatched.join(', ')} differ from project. ` +
          'Pass --home-dir and --work-dir on the same volume as --project.',
      );
    }
    if (ctx.volumes.home.mount !== sims.mount)
      console.log(
        `note: the home volume (${ctx.volumes.home.mount}) is not the volume the simulators use (${sims.mount})`,
      );
  }
}

function startSampler(ctx) {
  const config = {
    out: ctx.out,
    home: ctx.home,
    cli: ctx.stim.cli,
    worktreePrefix: ctx.worktreePrefix,
    intervalMs: SAMPLE_INTERVAL_SEC * 1000,
    statusEveryMs: STATUS_EVERY_MS,
    parentPid: process.pid,
    startedAt: ctx.startedAt,
    extraEnv: ctx.opts.extraEnv,
    volumes: { simulators: ctx.simulatorsPath, home: ctx.homeDir, work: ctx.workDir },
  };
  writeFileSync(join(ctx.out, 'sampler.json'), JSON.stringify(config));
  const log = openSync(join(ctx.out, 'sampler.out'), 'a');
  const child = spawn(process.execPath, [join(HERE, 'sampler.mjs'), join(ctx.out, 'sampler.json')], {
    stdio: ['ignore', log, log],
  });
  closeSync(log);
  const exited = new Promise((resolveExit) => child.on('exit', resolveExit));
  return {
    async stop() {
      writeFileSync(join(ctx.out, 'STOP'), '');
      const waitFor = async (ms) => {
        const timer = new AbortController();
        await Promise.race([exited.then(() => timer.abort()), sleep(ms, timer.signal)]);
      };
      await waitFor(30_000);
      if (child.exitCode === null) child.kill('SIGTERM');
      await waitFor(15_000);
      if (child.exitCode === null) child.kill('SIGKILL');
    },
  };
}

function describeBuild(version, commit) {
  return `stim ${version || 'unknown version'}${commit ? `, checkout at ${commit.slice(0, 9)}` : ''}`;
}

async function buildIdentity(ctx) {
  const version = await runCommand(process.execPath, [ctx.stim.cli, '--version'], {
    env: ctx.stim.env,
    timeoutMs: 60_000,
  });
  const git = await runCommand('git', ['-C', dirname(realpathSync(ctx.stim.cli)), 'rev-parse', 'HEAD']);
  return { version: version.stdout.trim(), commit: git.code === 0 ? git.stdout.trim() : null };
}

function daemonLabel(ctx) {
  const reported = ctx.snapshots.findLast((poll) => poll.daemon !== null && poll.daemon !== undefined);
  if (reported) {
    const { mode, running, lastTickAt } = reported.daemon;
    return `mode ${mode ?? 'unknown'}, ${running ? `running since ${running.since}` : 'not running'}, last tick ${lastTickAt ?? 'never'}`;
  }
  return existsSync(join(ctx.out, 'evidence', 'daemon', 'snapshot.json'))
    ? 'daemon snapshot.json present (evidence/daemon)'
    : null;
}

function removeCreatedDirs(ctx) {
  for (const dir of ctx.createdDirs.toReversed()) {
    try {
      rmdirSync(dir);
    } catch {}
  }
}

async function prepare(ctx) {
  const { opts } = ctx;
  if (!existsSync(resolve(opts.stim)))
    throw new UsageError(`--stim ${opts.stim} does not exist; build it with pnpm run build`);
  ensureDir(ctx, ctx.homeDir);
  ensureDir(ctx, ctx.workDir);
  settlePaths(ctx);
  console.log(`run ${ctx.runId}, results in ${ctx.out}`);
  console.log(`private STIM_HOME ${ctx.home}`);
  await reportVolumes(ctx);
  try {
    mkdirSync(ctx.home, { mode: 0o700 });
  } catch (error) {
    throw new UsageError(`cannot create the private home ${ctx.home}: ${error.message}`);
  }
  ctx.homeCreated = true;
  ctx.stim = createStim({
    cli: resolve(opts.stim),
    home: ctx.home,
    outDir: ctx.out,
    extraEnv: opts.extraEnv,
    signal: ctx.signal,
  });
  ctx.pods = podEnvironment(ctx.project);
  ctx.machine = await readMachine();
  ctx.deviceCap = derivedDeviceCap(ctx.machine.ramBytes);
  if ((await readSimulators()) === null)
    throw new HarnessError('xcrun simctl list devices failed; is Xcode installed and selected?');
  return buildIdentity(ctx);
}

async function runLocal(opts) {
  if (process.platform !== 'darwin') throw new UsageError('the harness drives iOS simulators and runs only on macOS');
  if (!existsSync(resolve(opts.project))) throw new UsageError(`--project ${opts.project} does not exist`);
  let ctx;
  for (let attempt = 0; attempt < 8; attempt++) {
    ctx = createContext(opts, `rme${Math.random().toString(16).slice(2, 6)}`);
    if (!existsSync(ctx.home) && !existsSync(ctx.ballastDir)) break;
  }
  guardEnv(opts.extraEnv);
  guardPaths(ctx);
  mkdirSync(ctx.out, { recursive: true });
  let build;
  try {
    build = await prepare(ctx);
  } catch (error) {
    if (ctx.homeCreated) rmSync(ctx.home, { recursive: true, force: true });
    removeCreatedDirs(ctx);
    throw error;
  }
  ctx.emit(
    'run',
    `${opts.scenario} with ${opts.workspaces} workspaces against ${describeBuild(build.version, build.commit)}`,
  );

  let interrupted = false;
  const onSignal = (name) => {
    if (interrupted) process.exit(130);
    interrupted = true;
    console.log(`${name} received: tearing down what the run created (signal again to quit at once)`);
    ctx.abort();
  };
  for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(name, () => onSignal(name));

  const sampler = startSampler(ctx);
  ctx.beforeHomeDelete = async () => {
    await sampler.stop();
    collectEvidence(ctx.home, ctx.out);
  };
  let harnessError = null;
  let torn = null;
  try {
    await SCENARIOS[opts.scenario](ctx);
  } catch (error) {
    harnessError = ctx.signal.aborted
      ? 'interrupted'
      : error instanceof HarnessError
        ? error.message
        : String(error?.stack ?? error);
    ctx.emit('error', harnessError);
  } finally {
    ctx.setStage('teardown');
    try {
      collectEvidence(ctx.home, ctx.out);
    } catch (error) {
      ctx.emit('error', `could not copy evidence: ${error?.message ?? error}`);
    }
    for (const cleanup of ctx.cleanups) await cleanup().catch(() => {});
    torn = await teardown(ctx);
    await sampler.stop();
  }
  if (interrupted) harnessError ??= 'interrupted';

  const endedAt = Date.now();
  const tearDownFailed =
    torn.errors.length > 0 ||
    torn.worktrees.some((w) => w.removed !== true) ||
    torn.homeDeleted !== true ||
    torn.ballastGone === false ||
    torn.unverified.length > 0;
  const samples = existsSync(join(ctx.out, 'samples.csv'))
    ? parseCsv(readFileSync(join(ctx.out, 'samples.csv'), 'utf8'))
    : [];
  const meta = {
    runId: ctx.runId,
    scenario: opts.scenario,
    targetLabel: `${ctx.machine.model ?? 'a Mac'}, ${Math.round((ctx.machine.ramBytes ?? 0) / 1024 ** 3)} GB, ${ctx.machine.cores} cores`,
    machineLabel: `${ctx.machine.model ?? 'unknown model'}, ${Math.round((ctx.machine.ramBytes ?? 0) / 1024 ** 3)} GB RAM, ${ctx.machine.cores} cores, macOS ${ctx.machine.macos}`,
    stimLabel: describeBuild(build.version, build.commit),
    projectLabel: 'the project',
    workspaces: ctx.workspaces.length,
    commit: ctx.commit,
    fingerprint: ctx.fingerprint,
    clockLabel: ctx.clocks
      ? `idle ${Math.round(ctx.idleWindowMs / 60000)} min (${ctx.clocks.idleKeys.join(', ')}); dormant ${ctx.clocks.dormant.minutes === null ? 'default' : ctx.clocks.dormant.available ? `${ctx.clocks.dormant.minutes} min` : `not available (${ctx.clocks.dormant.reason})`}`
      : 'not configured',
    startedAt: ctx.startedAt,
    durationMs: endedAt - ctx.startedAt,
    deviceCap: ctx.deviceCap,
    sampleIntervalSec: SAMPLE_INTERVAL_SEC,
    daemonLabel: daemonLabel(ctx),
    teardownClean: !tearDownFailed,
    uncleanPaths: torn.uncleanPaths,
  };
  const workspaces = ctx.workspaces.map((workspace) => ({
    label: workspace.label,
    role: workspace.role,
    record: ctx.record(workspace),
  }));
  const report = renderReport({
    meta,
    assertions: ctx.assertions.list,
    workspaces,
    events: ctx.events,
    samples,
    teardown: torn,
    harnessError,
  });
  writeFileSync(join(ctx.out, 'report.md'), report);
  writeFileSync(join(ctx.out, 'assertions.json'), JSON.stringify(ctx.assertions.list, null, 2));
  const failed = ctx.assertions.list.filter((assertion) => assertion.status === STATUS.fail).length;
  console.log(
    `report: ${join(ctx.out, 'report.md')} (${failed} failed assertions${harnessError ? ', harness stopped early' : ''})`,
  );
  if (tearDownFailed) console.log('teardown did not finish cleanly: see the Teardown section of the report');
  return harnessError || tearDownFailed ? 2 : failed ? 1 : 0;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(error.message);
    return 2;
  }
  try {
    if (opts.target !== 'local') {
      const runId = `rme${Math.random().toString(16).slice(2, 6)}`;
      const localOut = resolve(opts.out ?? join('rm-e2e-out', `${stamp()}-${runId}`));
      return await runRemote(opts, { runId, localOut, emit: (kind, msg) => console.log(`${kind}: ${msg}`) });
    }
    return await runLocal(opts);
  } catch (error) {
    if (error instanceof UsageError || error instanceof HarnessError) {
      console.error(error.message);
      return 2;
    }
    throw error;
  }
}

process.exitCode = await main();
