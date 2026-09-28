import {
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  rmdirSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import { cpus, loadavg } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { fingerprintProject, refingerprintAfterMutation } from '../cache/build-cache.ts';
import { getExecutor } from '../exec.ts';
import { readPodState, podsAreStale, runPodInstall } from '../engine/deps.ts';
import { planPrebuild, recordPrebuild, runPrebuild } from '../engine/prebuild.ts';
import { buildIos, compilationCacheActivityLine } from '../engine/xcode.ts';
import { buildAndroid } from '../engine/gradle.ts';
import { CCACHE_UNAVAILABLE, ccacheActivityLine, resolveCcache } from '../engine/ccache.ts';
import { createNdjsonWriter } from '../ndjson.ts';
import type { Optimizations } from '../optimizations.ts';
import { podAction } from '../commands/ios/support.ts';
import {
  RESULT_MARKER,
  distBuildId,
  javaMajorAt,
  type WorkerBuildRequest,
  type WorkerBuildResult,
  type WorkerProbe,
  type WorkerTimings,
  type WorkerWarmRequest,
} from './protocol.ts';

const GENERIC_SIM_DESTINATION = 'generic/platform=iOS Simulator';
const DEPS_MARKER = '.stim-offload-deps';
const FILES_MARKER = '.stim-offload-files';

const distDir = dirname(fileURLToPath(import.meta.url));
const workerRoot = process.env.STIM_OFFLOAD_ROOT ?? resolve(distDir, '../../../..');

function onNote(line: string): void {
  process.stderr.write(`${line}\n`);
}

function emit(value: unknown): void {
  process.stdout.write(`\n${RESULT_MARKER}${JSON.stringify(value)}\n`);
}

function quiet(file: string, args: string[]): string | null {
  return getExecutor().runFileQuiet(file, args, { timeoutMs: 20_000 });
}

function availableMemBytes(): number | null {
  const text = quiet('vm_stat', []);
  if (!text) return null;
  const pageSize = Number(/page size of (\d+) bytes/.exec(text)?.[1] ?? 16384);
  const pages = (label: string) => Number(new RegExp(`${label}:\\s+(\\d+)`).exec(text)?.[1] ?? 0);
  return (pages('Pages free') + pages('Pages inactive') + pages('Pages speculative')) * pageSize;
}

function listDir(sdk: string | null, name: string): string[] {
  if (!sdk) return [];
  try {
    return readdirSync(join(sdk, name)).filter((entry) => !entry.startsWith('.'));
  } catch {
    return [];
  }
}

function javaMajor(): string | null {
  const home = process.env.JAVA_HOME || quiet('/usr/libexec/java_home', []);
  return home ? javaMajorAt(home) : null;
}

function probe(): WorkerProbe {
  const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? null;
  let stimVersion: string | null = null;
  try {
    stimVersion = JSON.parse(readFileSync(join(distDir, '..', 'package.json'), 'utf8')).version ?? null;
  } catch {}
  let diskFreeBytes: number | null = null;
  try {
    const s = statfsSync(workerRoot);
    diskFreeBytes = s.bavail * s.bsize;
  } catch {}
  const xcode = quiet('xcodebuild', ['-version']);
  const runtimes = (quiet('xcrun', ['simctl', 'list', 'runtimes']) ?? '')
    .split('\n')
    .filter((l) => l.startsWith('iOS '))
    .map((l) => l.split(' (')[0]!.trim());
  const running = quiet('pgrep', ['-x', 'xcodebuild']);
  return {
    root: workerRoot,
    stimVersion,
    stimBuildId: distBuildId(distDir),
    xcode: xcode ? xcode.trim().replace(/\n/g, ' / ') : null,
    simulatorSdk: quiet('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-version'])?.trim() ?? null,
    runtimes,
    cocoapods: quiet('pod', ['--version'])?.trim().split('\n').pop() ?? null,
    node: process.version,
    arch: process.arch,
    cpus: cpus().length,
    load1: loadavg()[0]!,
    availableMemBytes: availableMemBytes(),
    diskFreeBytes,
    xcodebuildRunning: running ? running.trim().split('\n').filter(Boolean).length : 0,
    gradleRunning: (quiet('pgrep', ['-f', 'GradleDaemon|GradleWrapperMain']) ?? '').split('\n').filter(Boolean).length,
    javaMajor: javaMajor(),
    androidSdk: sdk,
    ndk: listDir(sdk, 'ndk'),
    buildTools: listDir(sdk, 'build-tools'),
    platforms: listDir(sdk, 'platforms'),
  };
}

/** Deletes files the previous sync shipped that the new file list (NUL-separated, on stdin) no longer names. */
function prune(repoDir: string): { removed: number } {
  const next = readFileSync(0, 'utf8');
  const markerPath = join(repoDir, FILES_MARKER);
  const previous = existsSync(markerPath) ? readFileSync(markerPath, 'utf8') : '';
  const keep = new Set(next.split('\0').filter(Boolean));
  const root = resolve(repoDir);
  let removed = 0;
  for (const rel of previous.split('\0').filter(Boolean)) {
    if (keep.has(rel)) continue;
    const target = resolve(root, rel);
    if (!target.startsWith(root + sep)) continue;
    try {
      rmSync(target, { force: true });
      removed += 1;
    } catch {}
  }
  writeFileSync(`${markerPath}.tmp`, next);
  renameSync(`${markerPath}.tmp`, markerPath);
  return { removed };
}

function lockfileOf(repoDir: string): { file: string; command: string; args: (pkg: string | null) => string[] } | null {
  if (existsSync(join(repoDir, 'pnpm-lock.yaml'))) {
    return {
      file: 'pnpm-lock.yaml',
      command: 'pnpm',
      args: (pkg) => ['install', '--frozen-lockfile', ...(pkg ? ['--filter', `${pkg}...`] : [])],
    };
  }
  if (existsSync(join(repoDir, 'yarn.lock'))) {
    return { file: 'yarn.lock', command: 'yarn', args: () => ['install', '--frozen-lockfile'] };
  }
  if (existsSync(join(repoDir, 'package-lock.json'))) {
    return { file: 'package-lock.json', command: 'npm', args: () => ['ci'] };
  }
  return null;
}

async function ensureDeps(req: WorkerBuildRequest): Promise<boolean> {
  const lock = lockfileOf(req.repoDir);
  if (!lock) return false;
  const args = lock.args(req.packageName);
  const digest = createHash('sha256')
    .update(readFileSync(join(req.repoDir, lock.file)))
    .update(JSON.stringify(args))
    .digest('hex');
  const markerPath = join(req.repoDir, DEPS_MARKER);
  const projectModules = join(req.repoDir, req.projectRel, 'node_modules');
  if (existsSync(projectModules) && existsSync(markerPath) && readFileSync(markerPath, 'utf8') === digest) return false;
  process.stderr.write(`offload: ${lock.command} ${args.join(' ')}\n`);
  const child = getExecutor().spawn(lock.command, args, {
    cwd: req.repoDir,
    env: { ...process.env, CI: '1' },
    stdio: ['ignore', process.stderr, process.stderr],
  });
  const code = await new Promise<number | null>((done, fail) => {
    child.on('error', fail);
    child.on('exit', done);
  });
  if (code !== 0) throw new Error(`${lock.command} ${args.join(' ')} exited with ${code}`);
  writeFileSync(markerPath, digest);
  return true;
}

/**
 * xcodebuild compiles every simulator architecture (arm64 and x86_64) for the generic destination, so
 * the worker names one of its existing simulators on the local runtime. It is only a build
 * destination: nothing boots, installs on, or changes it.
 */
function simulatorDestination(runtime: string | null): string | null {
  if (!runtime) return null;
  try {
    const listed = JSON.parse(quiet('xcrun', ['simctl', 'list', 'devices', 'available', '-j']) ?? '{}') as {
      devices?: Record<string, Array<{ udid: string; name: string }>>;
    };
    const device = (listed.devices?.[runtime] ?? []).find((d) => d.name.startsWith('iPhone'));
    return device ? `id=${device.udid}` : null;
  } catch {
    return null;
  }
}

async function buildOnWorker(req: WorkerBuildRequest): Promise<WorkerBuildResult> {
  const platform = req.platform;
  const root = join(req.repoDir, req.projectRel);
  const timings: WorkerTimings = { depsMs: 0, prebuildMs: 0, podsMs: 0, fingerprintMs: 0, buildMs: 0 };
  const log = createNdjsonWriter(join(workerRoot, 'logs', `${Date.now()}-${platform}.ndjson`));
  const time = async <T>(key: keyof WorkerTimings, fn: () => Promise<T>): Promise<T> => {
    const started = Date.now();
    try {
      return await fn();
    } finally {
      timings[key] += Date.now() - started;
    }
  };

  let depsInstalled: boolean;
  try {
    depsInstalled = await time('depsMs', () => ensureDeps(req));
  } catch (e) {
    return { ok: false, code: 'deps-failed', message: String((e as Error)?.message || e), timings };
  }

  const initial = await time('fingerprintMs', () => fingerprintProject(root, { platform }));
  if (!initial) return { ok: false, code: 'no-fingerprint', message: 'worker could not fingerprint', timings };

  const mutations: string[] = [];
  const plan = planPrebuild(root, platform, {
    isExpo: req.isExpo,
    fingerprint: initial.hash,
    sources: initial.sources,
  });
  if (plan === 'refuse') return { ok: false, code: 'prebuild-refused', message: 'stale native dir', timings };
  if (plan === 'generate' || plan === 'regenerate') {
    recordPrebuild(root, platform, null);
    const result = await time('prebuildMs', () => runPrebuild(root, platform, log, { clean: plan === 'regenerate' }));
    if (result?.failed) return { ok: false, code: 'prebuild-failed', message: result.reason ?? 'prebuild', timings };
    mutations.push('prebuild');
  }

  const podState = platform === 'ios' ? readPodState(root) : null;
  const action = podState
    ? podAction(podState, podsAreStale(podState.lockText, podState.manifestText))
    : { install: false };
  if (action.install) {
    const result = await time('podsMs', () =>
      runPodInstall(root, log, { onHeartbeat: (l) => process.stderr.write(`${l}\n`) }),
    );
    if (result?.failed) return { ok: false, code: 'pods-failed', message: result.reason ?? 'pod install', timings };
    mutations.push('pods');
  }

  let fingerprint = initial.hash;
  let sources = initial.sources;
  if (mutations.length) {
    const after = await time('fingerprintMs', () =>
      refingerprintAfterMutation({ projectRoot: root, platform, previousHash: initial.hash }),
    );
    if (!after) return { ok: false, code: 'no-fingerprint', message: 'no fingerprint after mutation', timings };
    fingerprint = after.hash;
    sources = after.sources;
    if (mutations.includes('prebuild')) recordPrebuild(root, platform, after.hash);
  }
  if (req.expectedFingerprint !== null && fingerprint !== req.expectedFingerprint) {
    return {
      ok: false,
      code: 'fingerprint-mismatch',
      message: `worker fingerprint ${fingerprint} != local ${req.expectedFingerprint}`,
      fingerprint,
      sources: sources.map((s) => Object.assign({}, s, { contents: undefined })),
      timings,
    };
  }

  let artifactPath: string;
  let compilerCache: string;
  if (platform === 'ios') {
    const destination = simulatorDestination(req.runtime);
    if (req.runtime && !destination) {
      return {
        ok: false,
        code: 'no-runtime',
        message: `the worker has no iPhone simulator on ${req.runtime}`,
        timings,
      };
    }
    const built = await time('buildMs', () =>
      buildIos({
        root,
        destination: destination ?? GENERIC_SIM_DESTINATION,
        logWriter: log,
        ...(req.scheme ? { scheme: req.scheme } : {}),
        ...(req.configuration ? { configuration: req.configuration } : {}),
        ...(req.optimizations ? { optimizations: req.optimizations as Optimizations['ios'] } : {}),
        onHeartbeat: (l) => process.stderr.write(`${l}\n`),
        onNote: (l) => process.stderr.write(`${l}\n`),
      }),
    );
    if (!built.ok) {
      log.close();
      return { ok: false, code: built.code, message: built.tail.slice(-5).join('\n'), timings };
    }
    artifactPath = built.appPath;
    compilerCache = compilationCacheActivityLine(built.compilationCache);
  } else {
    const gradle = req.android ?? { variant: null, abi: null, buildCache: true, pch: 'auto', compilerCache: 'ccache' };
    const built = await time('buildMs', () =>
      buildAndroid(
        { root, logWriter: log, variant: gradle.variant, abi: gradle.abi },
        {
          buildCache: gradle.buildCache,
          pch: gradle.pch,
          compilerCacheDisabled: gradle.compilerCache === 'none',
          ccache: gradle.compilerCache === 'ccache' ? resolveCcache({ root, onNote }) : null,
          onHeartbeat: onNote,
          onNote,
        },
      ),
    );
    if (!built.ok) {
      log.close();
      return { ok: false, code: built.code, message: (built.lastLines ?? []).slice(-5).join('\n'), timings };
    }
    artifactPath = built.apkPath!;
    compilerCache = `ccache ${ccacheActivityLine(built.ccache ?? CCACHE_UNAVAILABLE)}`;
  }
  log.close();
  const settled = await refingerprintAfterMutation({ projectRoot: root, platform, previousHash: fingerprint });
  if (!settled || settled.moved) {
    return { ok: false, code: 'fingerprint-moved', message: 'inputs changed during the worker build', timings };
  }
  return {
    ok: true,
    appPath: artifactPath,
    fingerprint,
    depsInstalled,
    prebuild: plan,
    podsInstalled: action.install,
    compilationCache: compilerCache,
    timings,
  };
}

async function main(): Promise<void> {
  const [mode, arg] = process.argv.slice(2);
  if (mode === 'probe') return emit(probe());
  if (mode === 'prune' && arg) return emit(prune(arg));
  if (mode === 'build' && arg) {
    const req = JSON.parse(Buffer.from(arg, 'base64').toString('utf8')) as WorkerBuildRequest;
    return emit(await buildOnWorker(req));
  }
  if (mode === 'warm' && arg) {
    const log = join(workerRoot, 'logs', `${Date.now()}-warm.log`);
    mkdirSync(dirname(log), { recursive: true });
    const out = openSync(log, 'a');
    const child = getExecutor().spawn(process.execPath, [fileURLToPath(import.meta.url), 'warm-run', arg], {
      detached: true,
      stdio: ['ignore', out, out],
    });
    child.unref();
    return emit({ ok: true, pid: child.pid, log });
  }
  if (mode === 'warm-run' && arg) {
    const req = JSON.parse(Buffer.from(arg, 'base64').toString('utf8')) as WorkerWarmRequest;
    try {
      for (const build of req.builds) {
        const started = Date.now();
        const result = await buildOnWorker(build);
        process.stderr.write(
          `warm ${build.platform}: ${JSON.stringify({ ...result, wallMs: Date.now() - started })}\n`,
        );
      }
    } finally {
      try {
        rmdirSync(req.unlockDir);
      } catch {}
    }
    return;
  }
  process.stderr.write(
    'usage: offload-worker probe | prune <repoDir> | build <base64 request> | warm <base64 request>\n',
  );
  process.exitCode = 2;
}

main().catch((e) => {
  emit({ ok: false, code: 'worker-crashed', message: String((e as Error)?.stack || e) });
});
