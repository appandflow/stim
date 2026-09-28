import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, loadavg } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getExecutor } from '../exec.ts';
import { listBuildSlots } from '../engine/build-slots.ts';
import type { NdjsonWriter } from '../ndjson.ts';
import {
  distBuildId,
  parseWorkerOutput,
  type WorkerBuildRequest,
  type WorkerBuildResult,
  type WorkerProbe,
  type WorkerTimings,
} from './protocol.ts';

const WORKER_ENV = '~/.stim-offload.env';
const WORKER_NODE = `source ${WORKER_ENV} && node "$STIM_OFFLOAD_ROOT/stim/node_modules/stim/dist/offload-worker.mjs"`;
const SSH_OPTS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'ServerAliveInterval=15'];
const MIN_WORKER_DISK = 8 * 1024 ** 3;
const MIN_WORKER_MEM = 2 * 1024 ** 3;

export interface OffloadDecision {
  host: string;
  offload: boolean;
  reasons: string[];
  local: { load1: number; cpus: number; activeBuilds: number; maxBuilds: number | null };
  worker: WorkerProbe | null;
  probeMs: number;
}

interface OffloadTimings {
  probeMs: number;
  lockMs: number;
  syncMs: number;
  remoteMs: number;
  fetchMs: number;
  totalMs: number;
  worker: WorkerTimings;
}

export type OffloadOutcome =
  | { ok: true; appPath: string; timings: OffloadTimings; result: Extract<WorkerBuildResult, { ok: true }> }
  | { ok: false; reason: string; timings: Partial<OffloadTimings>; result?: WorkerBuildResult };

export function offloadHost(env: NodeJS.ProcessEnv = process.env): string | null {
  const host = env.STIM_OFFLOAD_HOST?.trim();
  return host ? host : null;
}

function sshArgs(host: string, command: string): string[] {
  return [...SSH_OPTS, host, `zsh -lc '${command}'`];
}

function ssh(host: string, command: string, { timeoutMs }: { timeoutMs?: number } = {}) {
  return getExecutor().runFileAsync('ssh', sshArgs(host, command), timeoutMs ? { timeoutMs } : {});
}

function quiet(file: string, args: string[]): string | null {
  return getExecutor().runFileQuiet(file, args, { timeoutMs: 20_000 });
}

function localToolchain(): { xcode: string | null; simulatorSdk: string | null; cocoapods: string | null } {
  const xcode = quiet('xcodebuild', ['-version']);
  return {
    xcode: xcode ? xcode.trim().replace(/\n/g, ' / ') : null,
    simulatorSdk: quiet('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-version'])?.trim() ?? null,
    cocoapods: quiet('pod', ['--version'])?.trim().split('\n').pop() ?? null,
  };
}

/**
 * Whether to offload, from local pressure and the worker's own report. Pure so the policy can be read
 * and tested apart from SSH.
 */
export function decideOffload({
  force,
  loadRatio,
  local,
  toolchain,
  localBuildId,
  worker,
  workerError,
}: {
  force: boolean;
  loadRatio: number;
  local: OffloadDecision['local'];
  toolchain: ReturnType<typeof localToolchain>;
  localBuildId: string | null;
  worker: WorkerProbe | null;
  workerError: string | null;
}): { offload: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const perCore = local.load1 / local.cpus;
  const slotsFull = local.maxBuilds !== null && local.activeBuilds >= local.maxBuilds;
  const pressured = perCore >= loadRatio;
  if (force) reasons.push('forced by STIM_OFFLOAD_FORCE');
  if (slotsFull) reasons.push(`build slots full (${local.activeBuilds}/${local.maxBuilds})`);
  if (pressured) reasons.push(`local load ${local.load1.toFixed(1)} on ${local.cpus} cores (>= ${loadRatio}/core)`);
  if (!force && !slotsFull && !pressured) {
    return {
      offload: false,
      reasons: [
        `local has capacity (load ${local.load1.toFixed(1)}/${local.cpus} cores, ${local.activeBuilds} builds)`,
      ],
    };
  }
  if (!worker) return { offload: false, reasons: [...reasons, `worker unreachable: ${workerError ?? 'no probe'}`] };
  const refusals: string[] = [];
  if (!worker.stimBuildId || worker.stimBuildId !== localBuildId) {
    refusals.push(`worker Stim build ${worker.stimBuildId} != local ${localBuildId}`);
  }
  if (worker.arch !== process.arch) refusals.push(`worker CPU ${worker.arch} != local ${process.arch}`);
  if (worker.xcode !== toolchain.xcode) refusals.push(`Xcode ${worker.xcode} != local ${toolchain.xcode}`);
  if (worker.simulatorSdk !== toolchain.simulatorSdk) {
    refusals.push(`simulator SDK ${worker.simulatorSdk} != local ${toolchain.simulatorSdk}`);
  }
  if (worker.cocoapods !== toolchain.cocoapods) {
    refusals.push(`CocoaPods ${worker.cocoapods} != local ${toolchain.cocoapods}`);
  }
  const workerPerCore = worker.load1 / worker.cpus;
  if (workerPerCore >= 1) refusals.push(`worker busy (load ${worker.load1.toFixed(1)} on ${worker.cpus} cores)`);
  if (worker.xcodebuildRunning >= 2) refusals.push(`worker already runs ${worker.xcodebuildRunning} xcodebuild`);
  if (worker.diskFreeBytes !== null && worker.diskFreeBytes < MIN_WORKER_DISK) {
    refusals.push(`worker disk ${(worker.diskFreeBytes / 1024 ** 3).toFixed(1)} GB free`);
  }
  if (worker.availableMemBytes !== null && worker.availableMemBytes < MIN_WORKER_MEM) {
    refusals.push(`worker memory ${(worker.availableMemBytes / 1024 ** 3).toFixed(1)} GB available`);
  }
  if (refusals.length) return { offload: false, reasons: [...reasons, ...refusals.map((r) => `refused: ${r}`)] };
  return {
    offload: true,
    reasons: [
      ...reasons,
      `worker load ${worker.load1.toFixed(1)}/${worker.cpus} cores, ${((worker.availableMemBytes ?? 0) / 1024 ** 3).toFixed(1)} GB mem, ${((worker.diskFreeBytes ?? 0) / 1024 ** 3).toFixed(0)} GB disk`,
    ],
  };
}

function localDistDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

export async function planOffload({
  host,
  maxBuilds,
  env = process.env,
}: {
  host: string;
  maxBuilds: number | null | undefined;
  env?: NodeJS.ProcessEnv;
}): Promise<OffloadDecision> {
  const local = {
    load1: loadavg()[0]!,
    cpus: cpus().length,
    activeBuilds: listBuildSlots().filter((slot) => slot.alive).length,
    maxBuilds: maxBuilds ?? null,
  };
  const force = env.STIM_OFFLOAD_FORCE === '1';
  const loadRatio = Number(env.STIM_OFFLOAD_LOAD_RATIO) || 1.5;
  const started = Date.now();
  let worker: WorkerProbe | null = null;
  let workerError: string | null = null;
  const pressured =
    force ||
    local.load1 / local.cpus >= loadRatio ||
    (local.maxBuilds !== null && local.activeBuilds >= local.maxBuilds);
  if (pressured) {
    try {
      worker = parseWorkerOutput<WorkerProbe>(await ssh(host, `${WORKER_NODE} probe`, { timeoutMs: 30_000 }));
      if (!worker) workerError = 'probe printed no result';
    } catch (e) {
      workerError = String((e as Error)?.message || e).split('\n')[0]!;
    }
  }
  const probeMs = Date.now() - started;
  const verdict = decideOffload({
    force,
    loadRatio,
    local,
    toolchain: localToolchain(),
    localBuildId: distBuildId(localDistDir()),
    worker,
    workerError,
  });
  return { host, ...verdict, local, worker, probeMs };
}

export function simulatorRuntime(udid: string): string | null {
  try {
    const listed = JSON.parse(quiet('xcrun', ['simctl', 'list', 'devices', '-j']) ?? '{}') as {
      devices?: Record<string, Array<{ udid: string }>>;
    };
    for (const [runtime, devices] of Object.entries(listed.devices ?? {})) {
      if (devices.some((d) => d.udid === udid)) return runtime;
    }
  } catch {}
  return null;
}

function repoIdentity(projectRoot: string): { repoRoot: string; projectRel: string; repoId: string } {
  const run = getExecutor().runFile;
  const repoRoot = realpathSync(run('git', ['-C', projectRoot, 'rev-parse', '--show-toplevel']));
  const common = realpathSync(run('git', ['-C', repoRoot, 'rev-parse', '--path-format=absolute', '--git-common-dir']));
  const id = createHash('sha256').update(common).digest('hex').slice(0, 10);
  return {
    repoRoot,
    projectRel: relative(repoRoot, realpathSync(projectRoot)),
    repoId: `${(basename(dirname(common)) || 'repo').replace(/[^A-Za-z0-9._-]/g, '_')}-${id}`,
  };
}

function sourceList(repoRoot: string): string {
  const listed = getExecutor().runFile('git', ['-C', repoRoot, 'ls-files', '-z', '-co', '--exclude-standard'], {
    untrimmed: true,
  });
  return listed
    .split('\0')
    .filter((rel) => {
      if (!rel) return false;
      try {
        return lstatSync(join(repoRoot, rel)).isFile() || lstatSync(join(repoRoot, rel)).isSymbolicLink();
      } catch {
        return false;
      }
    })
    .join('\0');
}

export async function offloadIosBuild({
  decision,
  projectRoot,
  expectedFingerprint,
  configuration,
  scheme,
  isExpo,
  optimizations,
  runtime,
  stagingDir,
  note,
  logWriter,
}: {
  decision: OffloadDecision;
  projectRoot: string;
  expectedFingerprint: string;
  configuration: string | null;
  scheme: string | null;
  isExpo: boolean;
  optimizations: unknown;
  runtime: string | null;
  stagingDir: string;
  note: (line: string) => void;
  logWriter: NdjsonWriter;
}): Promise<OffloadOutcome> {
  const { host } = decision;
  const started = Date.now();
  const timings: Partial<OffloadTimings> = { probeMs: decision.probeMs };
  const lap = (key: 'lockMs' | 'syncMs' | 'remoteMs' | 'fetchMs', since: number) => {
    timings[key] = Date.now() - since;
  };
  const fail = (reason: string, result?: WorkerBuildResult): OffloadOutcome => {
    timings.totalMs = Date.now() - started + decision.probeMs;
    logWriter.write({ src: 'build', level: 'warn', event: 'offload_failed', msg: reason, timings, result });
    return { ok: false, reason, timings, ...(result ? { result } : {}) };
  };

  let identity: ReturnType<typeof repoIdentity>;
  try {
    identity = repoIdentity(projectRoot);
  } catch (e) {
    return fail(`not a git checkout: ${(e as Error)?.message || e}`);
  }
  const { repoRoot, projectRel, repoId } = identity;
  const remoteRepo = `${decision.worker!.root}/repos/${repoId}`;
  const lockDir = `${remoteRepo}.lock`;

  let t = Date.now();
  try {
    await ssh(host, `mkdir -p "${remoteRepo}" && mkdir "${lockDir}"`, { timeoutMs: 20_000 });
  } catch (e) {
    const message = String((e as Error)?.message || e);
    return fail(
      message.includes('File exists')
        ? `the worker checkout ${remoteRepo} is locked by another offload (remove ${lockDir} if none runs)`
        : `could not lock the worker checkout: ${message.split('\n')[0]}`,
    );
  }
  lap('lockMs', t);

  try {
    t = Date.now();
    mkdirSync(stagingDir, { recursive: true });
    const listFile = join(stagingDir, 'files.list');
    const list = sourceList(repoRoot);
    writeFileSync(listFile, list);
    await getExecutor().runFileAsync(
      'rsync',
      [
        '-a',
        '-0',
        `--files-from=${listFile}`,
        '-e',
        `ssh ${SSH_OPTS.join(' ')}`,
        `${repoRoot}/`,
        `${host}:${remoteRepo}/`,
      ],
      { timeoutMs: 15 * 60_000 },
    );
    getExecutor().runFile('ssh', sshArgs(host, `${WORKER_NODE} prune "${remoteRepo}"`), {
      input: list,
      timeoutMs: 60_000,
    });
    lap('syncMs', t);
    note(`offload: synced ${list.split('\0').length} files to ${host}:${remoteRepo} in ${timings.syncMs}ms`);

    let packageName: string | null = null;
    try {
      packageName = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')).name ?? null;
    } catch {}
    const request: WorkerBuildRequest = {
      repoDir: remoteRepo,
      projectRel,
      packageName,
      expectedFingerprint,
      configuration,
      scheme,
      isExpo,
      optimizations,
      runtime,
    };
    const encoded = Buffer.from(JSON.stringify(request)).toString('base64');
    t = Date.now();
    let stdout: string;
    try {
      stdout = await ssh(host, `${WORKER_NODE} build-ios ${encoded}`, {
        timeoutMs: 60 * 60_000,
      });
    } catch (e) {
      lap('remoteMs', t);
      return fail(`worker build crashed: ${String((e as Error)?.message || e).slice(-400)}`);
    }
    lap('remoteMs', t);
    const result = parseWorkerOutput<WorkerBuildResult>(stdout);
    if (!result) return fail('worker printed no result');
    if (!result.ok) return fail(`worker ${result.code}: ${result.message}`, result);

    t = Date.now();
    const localApp = join(stagingDir, basename(result.appPath));
    rmSync(localApp, { recursive: true, force: true });
    await getExecutor().runFileAsync(
      'rsync',
      ['-a', '-e', `ssh ${SSH_OPTS.join(' ')}`, `${host}:${result.appPath}/`, `${localApp}/`],
      { timeoutMs: 15 * 60_000 },
    );
    lap('fetchMs', t);
    if (!existsSync(join(localApp, 'Info.plist'))) return fail(`fetched app has no Info.plist at ${localApp}`, result);
    const all: OffloadTimings = {
      probeMs: decision.probeMs,
      lockMs: timings.lockMs ?? 0,
      syncMs: timings.syncMs ?? 0,
      remoteMs: timings.remoteMs ?? 0,
      fetchMs: timings.fetchMs ?? 0,
      totalMs: Date.now() - started + decision.probeMs,
      worker: result.timings,
    };
    logWriter.write({ src: 'build', level: 'info', event: 'offload_done', msg: `offloaded to ${host}`, timings: all });
    return { ok: true, appPath: localApp, timings: all, result };
  } catch (e) {
    return fail(String((e as Error)?.message || e));
  } finally {
    try {
      await ssh(host, `rmdir "${lockDir}"`, { timeoutMs: 20_000 });
    } catch {}
  }
}
