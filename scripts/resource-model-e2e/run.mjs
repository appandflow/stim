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
  rmdirSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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
    knownPids: new Set(),
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
      appendFileSync(join(out, 'events.ndjson'), `${JSON.stringify(event)}\n`);
      console.log(`[${mmss(event.t - startedAt)}] ${kind}: ${msg}`);
    },
    setStage(name) {
      writeFileSync(join(out, 'stage'), name);
      ctx.emit('stage', name);
    },
    logFile(name, text) {
      writeFileSync(join(out, name), text);
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

function guardHome(ctx) {
  const realStim = join(homedir(), '.stim');
  const candidates = [ctx.homeDir, ctx.home];
  for (const candidate of candidates) {
    for (const root of [realStim, existsSync(realStim) ? realpathSync(realStim) : realStim]) {
      if (inside(resolve(candidate), root))
        throw new UsageError(
          `${candidate} is inside the real stim home ${realStim}; the harness only runs under a private home it creates`,
        );
    }
  }
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
      await Promise.race([exited, sleep(20_000)]);
      if (child.exitCode === null) child.kill('SIGKILL');
    },
  };
}

function describeBuild(version, commit) {
  return `stim ${version || 'unknown version'}${commit ? ` at ${commit.slice(0, 9)}` : ''}`;
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
  if (reported) return `status daemon line: ${JSON.stringify(reported.daemon).slice(0, 200)}`;
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
  guardHome(ctx);
  ensureDir(ctx, ctx.homeDir);
  ensureDir(ctx, ctx.workDir);
  console.log(`run ${ctx.runId}, results in ${ctx.out}`);
  console.log(`private STIM_HOME ${ctx.home}`);
  await reportVolumes(ctx);
  mkdirSync(ctx.home, { recursive: true, mode: 0o700 });
}

async function runLocal(opts) {
  if (process.platform !== 'darwin') throw new UsageError('the harness drives iOS simulators and runs only on macOS');
  if (!existsSync(resolve(opts.project))) throw new UsageError(`--project ${opts.project} does not exist`);
  const runId = `rme${Math.random().toString(16).slice(2, 6)}`;
  const ctx = createContext(opts, runId);
  mkdirSync(ctx.out, { recursive: true });
  try {
    await prepare(ctx);
  } catch (error) {
    removeCreatedDirs(ctx);
    throw error;
  }
  const stimPath = resolve(opts.stim);
  ctx.stim = createStim({
    cli: stimPath,
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
  const build = await buildIdentity(ctx);
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
    harnessError = error instanceof HarnessError ? error.message : String(error?.stack ?? error);
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
  const samples = existsSync(join(ctx.out, 'samples.csv'))
    ? parseCsv(readFileSync(join(ctx.out, 'samples.csv'), 'utf8'))
    : [];
  const meta = {
    runId,
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
  return harnessError ? 2 : failed ? 1 : 0;
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
