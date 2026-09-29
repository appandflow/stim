import { createHash } from 'node:crypto';
import {
  chmodSync,
  constants,
  copyFileSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fingerprintProject, refingerprintAfterMutation } from '../cache/build-cache.ts';
import { readPodState, podsAreStale, runPodInstall } from '../engine/deps.ts';
import { planPrebuild, recordPrebuild, runPrebuild } from '../engine/prebuild.ts';
import type { CcacheActivity, CompilationCacheActivity } from '../engine/build-facts.ts';
import { CCACHE_UNAVAILABLE, resolveCcache } from '../engine/ccache.ts';
import { assembleTaskFor, buildAndroid, gradlewPath } from '../engine/gradle.ts';
import { buildIos } from '../engine/xcode.ts';
import { getExecutor } from '../exec.ts';
import type { NdjsonWriter } from '../ndjson.ts';
import type { Optimizations } from '../optimizations.ts';
import { podAction } from '../commands/ios/support.ts';
import type { AndroidBuildOptions } from './client.ts';
import { workerToolchain } from './toolchain.ts';

/** One file of the client's checkout, as `git ls-files -co --exclude-standard` lists it. */
export interface ManifestEntry {
  path: string;
  kind: 'file' | 'exec' | 'link';
  size: number;
  sha256: string;
}

/** What stim-server hands this process on stdin; it has already checked every path and blob. */
export interface WorkerJob {
  job: string;
  area: string;
  blobs: string;
  manifest: ManifestEntry[];
  platform: 'ios' | 'android';
  project: string;
  packageName: string | null;
  isExpo: boolean;
  configuration: string | null;
  scheme: string | null;
  runtime: string | null;
  android: AndroidBuildOptions | null;
  expectedFingerprint: string;
  optimizations: Optimizations['ios'] | null;
  /** How long the client's Gradle daemon stays warm after an Android build; 0 or absent stops it when the build ends. */
  gradleDaemonIdleMs?: number;
}

export interface WorkerTimings {
  syncMs: number;
  depsMs: number;
  prebuildMs: number;
  podsMs: number;
  fingerprintMs: number;
  buildMs: number;
  packageMs: number;
}

export type WorkerResult =
  | {
      ok: true;
      artifact: { path: string; name: string; size: number; sha256: string };
      fingerprint: string;
      compilationCache: CompilationCacheActivity | CcacheActivity;
      timings: WorkerTimings;
    }
  | { ok: false; code: string; message: string; timings: WorkerTimings };

function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function note(phase: string, msg: string): void {
  emit({ type: 'phase', phase, msg });
}

function relayWriter(file: string): NdjsonWriter {
  let written = 0;
  return {
    file,
    write(record) {
      written += 1;
      emit({ type: 'log', record });
      return true;
    },
    close: () => ({ file, written, dropped: 0, lastError: null }),
    get written() {
      return written;
    },
    dropped: 0,
    lastError: null,
  };
}

function blobPath(blobs: string, sha256: string): string {
  return join(blobs, sha256.slice(0, 2), sha256);
}

/** Whether every directory above `path` inside `root` is a real directory, so removing it cannot leave `root`. */
function realParents(root: string, path: string): boolean {
  let current = root;
  for (const part of path.split('/').slice(0, -1)) {
    current = join(current, part);
    try {
      if (!lstatSync(current).isDirectory()) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** Makes every directory above `path` inside `root` a real directory, replacing a file or symlink in the way. */
function ensureParents(root: string, path: string): void {
  let current = root;
  for (const part of path.split('/').slice(0, -1)) {
    current = join(current, part);
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      mkdirSync(current);
      continue;
    }
    if (stat.isDirectory()) continue;
    rmSync(current, { force: true });
    mkdirSync(current);
  }
}

interface MirrorRecord {
  [path: string]: { sha256: string; kind: ManifestEntry['kind']; mtimeMs: number; size: number };
}

/**
 * Makes `src` hold exactly the manifest's files: a file the manifest names is rewritten unless this process
 * wrote that same content there and nothing touched it since; a file that git would list as untracked and not
 * ignored, and that the manifest does not name, is deleted, as is one the previous manifest named. Ignored
 * files (dependencies, generated native projects) stay, and the fingerprint check covers them.
 */
function materialize(job: WorkerJob, src: string): { written: number; removed: number } {
  const recordFile = join(job.area, 'mirror.json');
  let previous: MirrorRecord = {};
  try {
    previous = JSON.parse(readFileSync(recordFile, 'utf8')) as MirrorRecord;
  } catch {}
  mkdirSync(src, { recursive: true });
  if (!existsSync(join(src, '.git'))) {
    getExecutor().runFile('git', ['init', '--quiet', src], { timeoutMs: 30_000 });
    getExecutor().runFile('git', ['-C', src, 'config', 'core.excludesFile', '/dev/null'], { timeoutMs: 30_000 });
  }
  const next: MirrorRecord = {};
  const wanted = new Set<string>();
  let written = 0;
  for (const entry of job.manifest) {
    wanted.add(entry.path);
    const target = join(src, entry.path);
    const known = previous[entry.path];
    let stat = null;
    try {
      stat = lstatSync(target);
    } catch {}
    if (
      known &&
      stat &&
      known.sha256 === entry.sha256 &&
      known.kind === entry.kind &&
      stat.mtimeMs === known.mtimeMs &&
      stat.size === known.size
    ) {
      next[entry.path] = known;
      continue;
    }
    ensureParents(src, entry.path);
    if (stat) rmSync(target, { recursive: true, force: true });
    const blob = blobPath(job.blobs, entry.sha256);
    if (entry.kind === 'link') {
      symlinkSync(readFileSync(blob, 'utf8'), target);
    } else {
      copyFileSync(blob, target, constants.COPYFILE_FICLONE);
      chmodSync(target, entry.kind === 'exec' ? 0o755 : 0o644);
    }
    const after = lstatSync(target);
    next[entry.path] = { sha256: entry.sha256, kind: entry.kind, mtimeMs: after.mtimeMs, size: after.size };
    written += 1;
  }
  const untracked = getExecutor()
    .runFile('git', ['-C', src, 'ls-files', '-z', '-o', '--exclude-standard'], {
      untrimmed: true,
      timeoutMs: 120_000,
    })
    .split('\0')
    .filter(Boolean);
  let removed = 0;
  for (const path of new Set([...untracked, ...Object.keys(previous)])) {
    if (wanted.has(path) || !realParents(src, path)) continue;
    try {
      rmSync(join(src, path), { force: true });
      removed += 1;
    } catch {}
  }
  const tmp = `${recordFile}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(next));
  renameSync(tmp, recordFile);
  return { written, removed };
}

function lockfileOf(src: string): { file: string; command: string; args: (pkg: string | null) => string[] } | null {
  if (existsSync(join(src, 'pnpm-lock.yaml'))) {
    return {
      file: 'pnpm-lock.yaml',
      command: 'pnpm',
      args: (pkg) => ['install', '--frozen-lockfile', ...(pkg ? ['--filter', `${pkg}...`] : [])],
    };
  }
  if (existsSync(join(src, 'yarn.lock'))) {
    return { file: 'yarn.lock', command: 'yarn', args: () => ['install', '--frozen-lockfile'] };
  }
  if (existsSync(join(src, 'package-lock.json')))
    return { file: 'package-lock.json', command: 'npm', args: () => ['ci'] };
  return null;
}

/** Installs JavaScript dependencies when the lockfile, or the install command, changed since the last install. */
async function ensureDependencies(job: WorkerJob, src: string): Promise<void> {
  const lock = lockfileOf(src);
  if (!lock) return;
  const args = lock.args(job.packageName);
  const lockfile = readFileSync(join(src, lock.file));
  const digest = createHash('sha256').update(lockfile).update(JSON.stringify(args)).digest('hex');
  const marker = join(job.area, 'dependencies');
  const installed = () =>
    writeFileSync(join(job.area, 'lockfile'), createHash('sha256').update(lockfile).digest('hex'));
  if (existsSync(join(src, job.project, 'node_modules')) && existsSync(marker)) {
    if (readFileSync(marker, 'utf8') === digest) return installed();
  }
  note('deps', `${lock.command} ${args.join(' ')}`);
  const child = getExecutor().spawn(lock.command, args, {
    cwd: src,
    env: { ...process.env, CI: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const tail: string[] = [];
  const keep = (chunk: Buffer) => {
    tail.push(...String(chunk).split('\n').filter(Boolean));
    tail.splice(0, Math.max(0, tail.length - 5));
  };
  child.stdout?.on('data', keep);
  child.stderr?.on('data', keep);
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', resolve);
  });
  if (code !== 0) throw new Error(`${lock.command} ${args.join(' ')} exited with ${code}: ${tail.join(' | ')}`);
  writeFileSync(marker, digest);
  installed();
}

/**
 * The generic simulator destination compiles arm64 and x86_64, so the worker names one of its own iPhone
 * simulators on the client's runtime. It is a build destination only: nothing boots or installs on it.
 */
function destination(runtime: string): string | null {
  try {
    const listed = JSON.parse(
      getExecutor().runFileQuiet('xcrun', ['simctl', 'list', 'devices', 'available', '-j'], { timeoutMs: 20_000 }) ??
        '{}',
    ) as { devices?: Record<string, Array<{ udid: string; name: string }>> };
    const device = (listed.devices?.[runtime] ?? []).find((each) => each.name.startsWith('iPhone'));
    return device ? `id=${device.udid}` : null;
  } catch {
    return null;
  }
}

async function sha256Of(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function build(job: WorkerJob): Promise<WorkerResult> {
  const timings: WorkerTimings = {
    syncMs: 0,
    depsMs: 0,
    prebuildMs: 0,
    podsMs: 0,
    fingerprintMs: 0,
    buildMs: 0,
    packageMs: 0,
  };
  const time = async <T>(key: keyof WorkerTimings, run: () => T | Promise<T>): Promise<T> => {
    const started = Date.now();
    try {
      return await run();
    } finally {
      timings[key] += Date.now() - started;
    }
  };
  const failed = (code: string, message: string): WorkerResult => ({ ok: false, code, message, timings });
  const src = join(job.area, 'src');
  const root = join(src, job.project);

  const log = relayWriter(join(job.area, 'build.ndjson'));

  const mirrored = await time('syncMs', () => materialize(job, src));
  const realSrc = realpathSync(src);
  const realRoot = realpathSync(root);
  if (realRoot !== realSrc && !realRoot.startsWith(`${realSrc}/`))
    return failed('bad-project', `${job.project} leaves the checkout.`);
  note('sync', `${job.manifest.length} files, ${mirrored.written} written, ${mirrored.removed} removed`);
  try {
    await time('depsMs', () => ensureDependencies(job, src));
  } catch (error) {
    return failed('deps-failed', (error as Error).message);
  }

  const { platform } = job;
  const initial = await time('fingerprintMs', () => fingerprintProject(root, { platform }));
  if (!initial) return failed('no-fingerprint', 'The build machine could not fingerprint the project.');
  const plan = planPrebuild(root, platform, {
    isExpo: job.isExpo,
    fingerprint: initial.hash,
    sources: initial.sources,
  });
  if (plan === 'refuse') {
    return failed('prebuild-refused', `${platform}/ is not generated by prebuild and does not match.`);
  }
  const mutations: string[] = [];
  if (plan === 'generate' || plan === 'regenerate') {
    note('prebuild', plan === 'generate' ? `generating ${platform}/` : `regenerating ${platform}/ with --clean`);
    recordPrebuild(root, platform, null);
    const result = await time('prebuildMs', () => runPrebuild(root, platform, log, { clean: plan === 'regenerate' }));
    if (result?.failed) return failed('prebuild-failed', result.reason ?? 'expo prebuild failed.');
    mutations.push('prebuild');
  }
  if (platform === 'ios') {
    const podState = readPodState(root);
    const pods = podAction(podState, podsAreStale(podState.lockText, podState.manifestText));
    if (pods.install) {
      note('pods', `${pods.reason ?? 'Pods are stale'} -> pod install`);
      const result = await time('podsMs', () =>
        runPodInstall(root, log, { onHeartbeat: (line) => note('pods', line) }),
      );
      if (result?.failed) return failed('pods-failed', result.reason ?? 'pod install failed.');
      mutations.push('pods');
    }
  }
  let fingerprint = initial.hash;
  if (mutations.length) {
    const after = await time('fingerprintMs', () =>
      refingerprintAfterMutation({ projectRoot: root, platform, previousHash: initial.hash }),
    );
    if (!after) return failed('no-fingerprint', `No fingerprint after ${mutations.join(', ')}.`);
    fingerprint = after.hash;
    if (mutations.includes('prebuild')) recordPrebuild(root, platform, after.hash);
  }
  if (fingerprint !== job.expectedFingerprint) {
    return failed(
      'fingerprint-mismatch',
      `the checkout there fingerprints ${fingerprint.slice(0, 12)}, here ${job.expectedFingerprint.slice(0, 12)}`,
    );
  }

  const compiled =
    platform === 'android' ? await compileAndroid(job, root, log, time) : await compileIos(job, root, log, time);
  if (!compiled.ok) return failed(compiled.code, compiled.message);
  const settled = await time('fingerprintMs', () =>
    refingerprintAfterMutation({ projectRoot: root, platform, previousHash: fingerprint }),
  );
  if (!settled || settled.moved) return failed('fingerprint-moved', 'The inputs changed during the build there.');

  const out = join(job.area, 'out', job.job);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const archive = join(out, 'app.tgz');
  const name = basename(compiled.path);
  await time('packageMs', () =>
    getExecutor().runFileAsync(
      'tar',
      ['-czf', archive, '--options', 'gzip:compression-level=1', '-C', dirname(compiled.path), name],
      { timeoutMs: 600_000 },
    ),
  );
  const sha256 = await time('packageMs', () => sha256Of(archive));
  return {
    ok: true,
    artifact: { path: archive, name, size: statSync(archive).size, sha256 },
    fingerprint,
    compilationCache: compiled.cache,
    timings,
  };
}

type Timer = <T>(key: keyof WorkerTimings, run: () => T | Promise<T>) => Promise<T>;

type Compiled =
  | { ok: true; path: string; cache: CompilationCacheActivity | CcacheActivity }
  | { ok: false; code: string; message: string };

async function compileIos(job: WorkerJob, root: string, log: NdjsonWriter, time: Timer): Promise<Compiled> {
  const runtime = job.runtime ?? '';
  const target = destination(runtime);
  if (!target)
    return { ok: false, code: 'no-runtime', message: `There is no iPhone simulator on ${runtime} to build for.` };
  note('build', `xcodebuild for ${runtime}`);
  const built = await time('buildMs', () =>
    buildIos({
      root,
      destination: target,
      logWriter: log,
      ...(job.scheme ? { scheme: job.scheme } : {}),
      ...(job.configuration ? { configuration: job.configuration } : {}),
      ...(job.optimizations ? { optimizations: job.optimizations } : {}),
      onHeartbeat: (line) => note('build', line),
      onNote: (line) => note('build', line),
    }),
  );
  if (!built.ok) {
    const first = built.diagnostics[0]?.message;
    return {
      ok: false,
      code: built.code,
      message: first ?? (built.tail.slice(-3).join(' | ') || 'xcodebuild failed.'),
    };
  }
  return { ok: true, path: built.appPath, cache: built.compilationCache };
}

/**
 * Stops the Gradle daemons of this client's Gradle home. A daemon calls setsid, so it leaves the build's
 * process group and would outlive the job and its claim.
 */
function stopGradleDaemons(root: string, timeoutMs: number): void {
  const gradlew = gradlewPath(root);
  if (!existsSync(gradlew)) return;
  getExecutor().runFileQuiet(gradlew, ['--stop'], { cwd: dirname(gradlew), timeoutMs });
}

/**
 * Gradle reads `org.gradle.daemon.idletimeout` from the user home's gradle.properties, which overrides the
 * project's, so the daemon exits after that idle time instead of Gradle's three hours.
 */
function limitDaemonIdle(idleMs: number): void {
  const home = process.env.GRADLE_USER_HOME;
  if (!home) return;
  const file = join(home, 'gradle.properties');
  const wanted = `org.gradle.daemon.idletimeout=${idleMs}\n`;
  try {
    if (readFileSync(file, 'utf8') === wanted) return;
  } catch {}
  mkdirSync(home, { recursive: true });
  writeFileSync(file, wanted);
}

async function compileAndroid(job: WorkerJob, root: string, log: NdjsonWriter, time: Timer): Promise<Compiled> {
  const options = job.android;
  if (!options) return { ok: false, code: 'bad-request', message: 'The job has no Gradle options.' };
  const idleMs = job.gradleDaemonIdleMs ?? 0;
  const keepDaemon = idleMs > 0;
  limitDaemonIdle(keepDaemon ? idleMs : 60_000);
  const onNote = (line: string) => note('build', line);
  const stop = () => {
    stopGradleDaemons(root, 4000);
    process.exit(143);
  };
  process.once('SIGTERM', stop);
  note('build', `gradle ${assembleTaskFor(options.variant)} for ${options.abi ?? 'every ABI'}`);
  try {
    const built = await time('buildMs', () =>
      buildAndroid(
        { root, logWriter: log, variant: options.variant, abi: options.abi },
        {
          buildCache: options.gradleBuildCache,
          pch: options.pch,
          compilerCacheDisabled: options.compilerCache === 'none',
          ccache: options.compilerCache === 'ccache' ? resolveCcache({ root, onNote }) : null,
          onHeartbeat: onNote,
          onNote,
        },
      ),
    );
    if (!built.ok) {
      const first = built.diagnostics[0]?.message;
      return { ok: false, code: built.code, message: first ?? (built.lastLines.slice(-3).join(' | ') || built.reason) };
    }
    return { ok: true, path: built.apkPath, cache: built.ccache ?? CCACHE_UNAVAILABLE };
  } finally {
    process.off('SIGTERM', stop);
    if (!keepDaemon) stopGradleDaemons(root, 60_000);
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode === 'offer') return emit(workerToolchain());
  if (mode === 'build') {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    const job = JSON.parse(Buffer.concat(chunks).toString('utf8')) as WorkerJob;
    return emit({ type: 'result', ...(await build(job)) });
  }
  process.stderr.write('usage: offload-worker offer | build < job.json\n');
  process.exitCode = 2;
}

main().catch((error: unknown) => {
  emit({ type: 'result', ok: false, code: 'worker-crashed', message: String((error as Error)?.message ?? error) });
});
