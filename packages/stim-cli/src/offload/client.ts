import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, loadavg } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getExecutor } from '../exec.ts';
import { listBuildSlots } from '../engine/build-slots.ts';
import type { NdjsonWriter } from '../ndjson.ts';
import { workspaceDir } from '../workspace/paths.ts';
import { detectIsExpo } from '../workspace/project.ts';
import {
  distBuildId,
  javaMajorAt,
  parseWorkerOutput,
  type WorkerAndroidOptions,
  type WorkerBuildRequest,
  type WorkerBuildResult,
  type WorkerProbe,
  type WorkerTimings,
  type WorkerWarmRequest,
} from './protocol.ts';

const WORKER_ENV = '~/.stim-offload.env';
const WORKER_NODE = `source ${WORKER_ENV} && node "$STIM_OFFLOAD_ROOT/stim/node_modules/stim/dist/offload-worker.mjs"`;
const SSH_OPTS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'ServerAliveInterval=15'];
export const MIN_WORKER_DISK: number = 8 * 1024 ** 3;
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

export interface LocalToolchain {
  xcode: string | null;
  simulatorSdk: string | null;
  cocoapods: string | null;
  javaMajor: string | null;
}

export function localToolchain(platform: OffloadPlatform): LocalToolchain {
  if (platform === 'android') {
    return { xcode: null, simulatorSdk: null, cocoapods: null, javaMajor: javaMajor(process.env.JAVA_HOME) };
  }
  const xcode = quiet('xcodebuild', ['-version']);
  return {
    xcode: xcode ? xcode.trim().replace(/\n/g, ' / ') : null,
    simulatorSdk: quiet('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-version'])?.trim() ?? null,
    cocoapods: quiet('pod', ['--version'])?.trim().split('\n').pop() ?? null,
    javaMajor: null,
  };
}

/** Android SDK pieces the project's React Native version catalog asks for. */
export interface AndroidRequirements {
  ndkVersion: string | null;
  buildTools: string | null;
  compileSdk: string | null;
}

export function readAndroidRequirements(projectRoot: string): AndroidRequirements {
  let text = '';
  try {
    text = readFileSync(join(projectRoot, 'node_modules', 'react-native', 'gradle', 'libs.versions.toml'), 'utf8');
  } catch {}
  const value = (key: string) => new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, 'm').exec(text)?.[1] ?? null;
  return { ndkVersion: value('ndkVersion'), buildTools: value('buildTools'), compileSdk: value('compileSdk') };
}

/** Why a worker cannot build like this Mac, for the given platform; empty when it can. */
export function toolchainMismatches({
  platform,
  worker,
  toolchain,
  localBuildId,
  android,
}: {
  platform: OffloadPlatform;
  worker: WorkerProbe;
  toolchain: LocalToolchain;
  localBuildId: string | null;
  android: AndroidRequirements | null;
}): string[] {
  const out: string[] = [];
  if (!worker.stimBuildId || worker.stimBuildId !== localBuildId) {
    out.push(`worker Stim build ${worker.stimBuildId} (${worker.stimVersion}) != local ${localBuildId}`);
  }
  if (worker.arch !== process.arch) out.push(`worker CPU ${worker.arch} != local ${process.arch}`);
  if (platform === 'ios') {
    if (worker.xcode !== toolchain.xcode) out.push(`Xcode ${worker.xcode} != local ${toolchain.xcode}`);
    if (worker.simulatorSdk !== toolchain.simulatorSdk) {
      out.push(`simulator SDK ${worker.simulatorSdk} != local ${toolchain.simulatorSdk}`);
    }
    if (worker.cocoapods !== toolchain.cocoapods) {
      out.push(`CocoaPods ${worker.cocoapods} != local ${toolchain.cocoapods}`);
    }
    return out;
  }
  if (!worker.javaMajor || worker.javaMajor !== toolchain.javaMajor) {
    out.push(`JDK ${worker.javaMajor ?? 'missing'} != local ${toolchain.javaMajor}`);
  }
  if (!worker.androidSdk) out.push('worker has no ANDROID_HOME');
  if (android?.ndkVersion && !worker.ndk.includes(android.ndkVersion)) {
    out.push(`worker lacks NDK ${android.ndkVersion} (has ${worker.ndk.join(', ') || 'none'})`);
  }
  if (android?.buildTools && !worker.buildTools.includes(android.buildTools)) {
    out.push(`worker lacks build-tools ${android.buildTools}`);
  }
  if (
    android?.compileSdk &&
    !worker.platforms.some((p) => p.replace(/^android-/, '').split('.')[0] === android.compileSdk)
  ) {
    out.push(`worker lacks platform android-${android.compileSdk}`);
  }
  return out;
}

function javaMajor(javaHome: string | undefined): string | null {
  const home = javaHome || getExecutor().runFileQuiet('/usr/libexec/java_home', [], { timeoutMs: 20_000 });
  return home ? javaMajorAt(home) : null;
}

/**
 * Whether to offload, from local pressure and the worker's own report. Pure so the policy can be read
 * and tested apart from SSH.
 */
export function decideOffload({
  platform = 'ios',
  force,
  loadRatio,
  local,
  toolchain,
  localBuildId,
  android = null,
  worker,
  workerError,
}: {
  platform?: OffloadPlatform;
  force: boolean;
  loadRatio: number;
  local: OffloadDecision['local'];
  toolchain: LocalToolchain;
  localBuildId: string | null;
  android?: AndroidRequirements | null;
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
  const refusals = toolchainMismatches({ platform, worker, toolchain, localBuildId, android });
  const workerPerCore = worker.load1 / worker.cpus;
  if (workerPerCore >= 1) refusals.push(`worker busy (load ${worker.load1.toFixed(1)} on ${worker.cpus} cores)`);
  if (worker.xcodebuildRunning + worker.gradleRunning >= 2) {
    refusals.push(`worker already runs ${worker.xcodebuildRunning + worker.gradleRunning} native builds`);
  }
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

export async function probeWorker(
  host: string,
): Promise<{ worker: WorkerProbe | null; error: string | null; ms: number }> {
  const started = Date.now();
  try {
    const worker = parseWorkerOutput<WorkerProbe>(await ssh(host, `${WORKER_NODE} probe`, { timeoutMs: 30_000 }));
    return { worker, error: worker ? null : 'probe printed no result', ms: Date.now() - started };
  } catch (e) {
    return { worker: null, error: String((e as Error)?.message || e).split('\n')[0]!, ms: Date.now() - started };
  }
}

export function localStimBuildId(): string | null {
  return distBuildId(localDistDir());
}

export async function planOffload({
  host,
  platform = 'ios',
  projectRoot,
  maxBuilds,
  env = process.env,
}: {
  host: string;
  platform?: OffloadPlatform;
  projectRoot: string;
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
  let worker: WorkerProbe | null = null;
  let workerError: string | null = null;
  let probeMs = 0;
  const pressured =
    force ||
    local.load1 / local.cpus >= loadRatio ||
    (local.maxBuilds !== null && local.activeBuilds >= local.maxBuilds);
  if (pressured) {
    const probed = await probeWorker(host);
    ({ worker, error: workerError, ms: probeMs } = probed);
  }
  const verdict = decideOffload({
    platform,
    force,
    loadRatio,
    local,
    toolchain: localToolchain(platform),
    localBuildId: localStimBuildId(),
    android: platform === 'android' ? readAndroidRequirements(projectRoot) : null,
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

export type OffloadPlatform = 'ios' | 'android';

async function syncSource({
  host,
  repoRoot,
  remoteRepo,
  stagingDir,
}: {
  host: string;
  repoRoot: string;
  remoteRepo: string;
  stagingDir: string;
}): Promise<number> {
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
  rmSync(listFile, { force: true });
  return list.split('\0').length;
}

function projectPackageName(projectRoot: string): string | null {
  try {
    return JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')).name ?? null;
  } catch {
    return null;
  }
}

/**
 * Starts a detached build of this checkout's current state on the worker, for iOS and Android, so its
 * dependencies, generated native projects, DerivedData, compilation cache, Gradle and ccache caches are
 * warm before the first offloaded build. The worker releases the checkout lock when it finishes; an
 * offload that arrives meanwhile finds the lock held and builds on this Mac.
 */
export async function warmOffloadWorker({
  projectRoot,
  note,
}: {
  projectRoot: string;
  note: (line: string) => void;
}): Promise<void> {
  const host = offloadHost();
  if (!host) return;
  const { worker, error } = await probeWorker(host);
  if (!worker) return note(`offload warm skipped: worker unreachable (${error})`);
  if (worker.diskFreeBytes !== null && worker.diskFreeBytes < MIN_WORKER_DISK) {
    return note(`offload warm skipped: ${worker.root} has ${(worker.diskFreeBytes / 1024 ** 3).toFixed(1)} GB free`);
  }
  const platforms = (['ios', 'android'] as const).filter(
    (platform) =>
      toolchainMismatches({
        platform,
        worker,
        toolchain: localToolchain(platform),
        localBuildId: localStimBuildId(),
        android: platform === 'android' ? readAndroidRequirements(projectRoot) : null,
      }).length === 0,
  );
  if (!platforms.length) return note('offload warm skipped: the worker matches no platform (see stim doctor)');
  let identity: ReturnType<typeof repoIdentity>;
  try {
    identity = repoIdentity(projectRoot);
  } catch {
    return;
  }
  const remoteRepo = `${worker.root}/repos/${identity.repoId}`;
  const lockDir = `${remoteRepo}.lock`;
  try {
    await ssh(host, `mkdir -p "${remoteRepo}" && mkdir "${lockDir}"`, { timeoutMs: 20_000 });
  } catch {
    return note(`offload warm skipped: ${lockDir} is held`);
  }
  try {
    const stagingDir = join(workspaceDir(projectRoot), 'offload-warm');
    const files = await syncSource({ host, repoRoot: identity.repoRoot, remoteRepo, stagingDir });
    rmSync(stagingDir, { recursive: true, force: true });
    const sdk = localToolchain('ios').simulatorSdk;
    const base = {
      repoDir: remoteRepo,
      projectRel: identity.projectRel,
      packageName: projectPackageName(projectRoot),
      expectedFingerprint: null,
      configuration: null,
      scheme: null,
      isExpo: detectIsExpo(projectRoot),
      optimizations: null,
    };
    const builds: WorkerBuildRequest[] = platforms.map((platform) =>
      platform === 'ios'
        ? { ...base, platform, runtime: sdk ? `com.apple.CoreSimulator.SimRuntime.iOS-${sdk.replace('.', '-')}` : null }
        : {
            ...base,
            platform,
            runtime: null,
            android: { variant: null, abi: 'arm64-v8a', buildCache: true, pch: 'auto', compilerCache: 'ccache' },
          },
    );
    const encoded = Buffer.from(JSON.stringify({ builds, unlockDir: lockDir } satisfies WorkerWarmRequest)).toString(
      'base64',
    );
    const started = parseWorkerOutput<{ log: string }>(
      await ssh(host, `${WORKER_NODE} warm ${encoded}`, { timeoutMs: 30_000 }),
    );
    note(
      `offload warm: synced ${files} files; ${host} is building ${platforms.join(' and ')} in the background (${started?.log ?? 'no log'})`,
    );
  } catch (e) {
    try {
      await ssh(host, `rmdir "${lockDir}"`, { timeoutMs: 20_000 });
    } catch {}
    note(`offload warm failed: ${String((e as Error)?.message || e).split('\n')[0]}`);
  }
}

export async function offloadBuild({
  platform,
  android,
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
  platform: OffloadPlatform;
  android?: WorkerAndroidOptions;
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
    const files = await syncSource({ host, repoRoot, remoteRepo, stagingDir });
    lap('syncMs', t);
    note(`offload: synced ${files} files to ${host}:${remoteRepo} in ${timings.syncMs}ms`);
    const packageName = projectPackageName(projectRoot);
    const request: WorkerBuildRequest = {
      platform,
      ...(android ? { android } : {}),
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
      stdout = await ssh(host, `${WORKER_NODE} build ${encoded}`, {
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
    const directory = platform === 'ios' ? '/' : '';
    await getExecutor().runFileAsync(
      'rsync',
      ['-a', '-e', `ssh ${SSH_OPTS.join(' ')}`, `${host}:${result.appPath}${directory}`, `${localApp}${directory}`],
      { timeoutMs: 15 * 60_000 },
    );
    lap('fetchMs', t);
    if (!existsSync(platform === 'ios' ? join(localApp, 'Info.plist') : localApp)) {
      return fail(`fetched artifact is incomplete at ${localApp}`, result);
    }
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
