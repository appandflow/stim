import { dependencyInstall, type StimContext, withAmbientContext } from '@stim-cli/core';
import { processContext } from '../cli-operation.ts';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  reactNativeArtifactReceipt,
  reactNativeArtifactToolchain,
  reactNativeBuildQuery,
} from './react-native-artifact.ts';
import { apkPackage, dumpApkManifest } from '../commands/android/support.ts';
import {
  chmodSync,
  constants,
  copyFileSync,
  cpSync,
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, delimiter, dirname, join, relative, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { fingerprintProject, refingerprintAfterMutation } from '../cache/build-cache.ts';
import { buildIos, buildAndroid, gradlewPath } from '../integrations/react-native-build.ts';
import { clearCorruptCompilationCache, COMPILATION_CACHE_CORRUPT } from '../cache/compilation-cache-corruption.ts';
import { readPodState, podsAreStale, runPodInstall } from '../engine/deps.ts';
import { planPrebuild, recordPrebuild, runPrebuild } from '../engine/prebuild.ts';
import type { CcacheActivity, CompilationCacheActivity } from '../engine/build-facts.ts';
import { CCACHE_UNAVAILABLE, resolveCcache } from '../engine/ccache.ts';
import { assembleTaskFor } from '../engine/gradle.ts';

import { getExecutor } from '../exec.ts';
import { git } from '../workspace/git.ts';
import { logLines } from '../macos/run.ts';
import { stripAnsi } from '../process-output.ts';
import { resolveBundleExtras, stageBundle } from '../macos/stage.ts';
import { manifestDigest } from './manifest.ts';
import { pathNodeVersion, projectNodeLine, unmetNodePin, withProjectNode } from '../supervisor/project-node.ts';
import { parseNdjsonText, type NdjsonWriter } from '../ndjson.ts';
import type { Optimizations } from '../optimizations.ts';
import { podAction } from '../commands/ios/support.ts';
import type { AndroidBuildOptions } from './client.ts';
import { availableIphone, workerToolchain } from './toolchain.ts';
import { verifyNativeTransfer } from './native-source.ts';
import { selectNativeXcodeProject } from '../integrations/native-xcode-project.ts';
import { nativeXcodeMetadataDirectories } from '../integrations/native-xcode-inputs.ts';
import type {
  BuildAndroidOptions,
  BuildStartParams,
  BuildSwiftpmArtifactQuery,
  GradleOffloadInputs,
} from '@stim-cli/core/protocol';
import {
  swiftpmWorkerArtifactSnapshot,
  swiftpmArtifactFromReceipt,
  readSwiftpmWorkerToolchain,
} from './swiftpm-artifact.ts';
import type { SwiftpmArtifactReceipt } from './swiftpm-artifact.ts';
import { isJsonObject, windowsShortDir, windowsShortDirKey } from '@stim-cli/core/state';
import { projectRegistry } from '../integrations/projects.ts';
import type { IosProject } from '../integrations/ios-project.ts';
import { buildIosOperation } from '../commands/ios/build.ts';
import { buildAndroidOperation } from '../commands/android/build.ts';
import {
  gradleOffloadInputs,
  gradleStateDirectories,
  nativeGradleOutputs,
  validateGradleManifest,
  verifyGradleTransfer,
} from '../integrations/native-gradle-inputs.ts';
import { writeConfigSetting } from '../workspace/config.ts';
import {
  nativeGradleArtifactSnapshotFromReceipt,
  nativeGradleWorkerArtifactIdentity,
  nativeGradleWorkerScope,
  type NativeGradleArtifactReceipt,
} from '../integrations/native-gradle-artifact-inputs.ts';
import { workspaceDir, workspaceLogsDir } from '../workspace/paths.ts';
import {
  androidLayoutSetting,
  iosProjectDirSetting,
  type AndroidLayout,
  type IosProjectDir,
} from '../workspace/settings.ts';

/** One entry of the source transfer: a visible file of the checkout, or a native build's file or directory input. */
export interface ManifestEntry {
  path: string;
  kind: 'file' | 'exec' | 'link' | 'directory';
  size: number;
  sha256: string;
}

/** What stim-server hands this process on stdin; it has already checked every path and blob. */
export interface WorkerJob {
  job: string;
  area: string;
  blobs: string;
  manifest: ManifestEntry[];
  platform: 'ios' | 'android' | 'macos';
  macos: {
    product: string;
    infoPlist: string;
    bundleId: string;
    resources?: Record<string, string>;
    assetCatalog?: string | null;
    artifactInputs?: BuildSwiftpmArtifactQuery['inputs'];
  } | null;
  swiftpmCache: string;
  project: string;
  packageName: string | null;
  isExpo: boolean;
  configuration: string | null;
  scheme: string | null;
  iosProjectPath?: string | null;
  runtime: string | null;
  android: AndroidBuildOptions | null;
  expectedFingerprint: string | null;
  cacheArtifact?: boolean;
  stimBuild?: string;
  native?: BuildStartParams['native'];
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
      fingerprint: string | null;
      androidPackage?: string;
      sourceDigest?: string;
      cacheArtifact?: { identity: { hash: string; key: string }; receipt: NativeGradleArtifactReceipt };
      reactNativeArtifact?: NonNullable<ReturnType<typeof reactNativeArtifactReceipt>>;
      swiftpmArtifact?: Awaited<ReturnType<typeof swiftpmWorkerArtifactSnapshot>>;
      compilationCache: CompilationCacheActivity | CcacheActivity | Record<string, never>;
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

const PRIVATE_DIRS = [
  "$ErrorActionPreference = 'Stop'",
  '$me = [Security.Principal.WindowsIdentity]::GetCurrent().User',
  '$acl = New-Object Security.AccessControl.DirectorySecurity',
  '$acl.SetAccessRuleProtection($true, $false)',
  "foreach ($sid in @($me, (New-Object Security.Principal.SecurityIdentifier 'S-1-5-18'))) {",
  "  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))",
  '}',
  'foreach ($line in [Console]::In.ReadToEnd().Split([char]10) | ForEach-Object { $_.Trim() } | Where-Object { $_ }) {',
  '  $dir, $key = $line.Split([char]9)',
  '  [void][IO.Directory]::CreateDirectory($dir, $acl)',
  '  $current = Get-Acl -LiteralPath $dir',
  '  $owner = $current.GetOwner([Security.Principal.SecurityIdentifier]).Value',
  "  if ($owner -notin @($me.Value, 'S-1-5-32-544', 'S-1-5-18')) { [Console]::Error.WriteLine(\"$dir is owned by $owner\"); exit 3 }",
  "  $foreign = $current.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | Where-Object { $_.IdentityReference.Value -notin @($me.Value, 'S-1-5-18') }",
  '  if (-not $current.AreAccessRulesProtected -or $foreign) { Set-Acl -LiteralPath $dir -AclObject $acl }',
  '  if ($key) {',
  '    $marker = "$dir.owner"',
  '    if (-not (Test-Path -LiteralPath $marker)) { Set-Content -NoNewline -LiteralPath $marker -Value $key }',
  '    elseif ((Get-Content -Raw -LiteralPath $marker) -ne $key) { [Console]::Error.WriteLine("$dir belongs to another build area"); exit 4 }',
  '  }',
  '}',
].join('\n');

/**
 * Creates each directory, in order, with access for this user and SYSTEM only, and gives an existing one that ACL.
 * A directory at the drive root inherits the root's ACL, which lets every authenticated user modify it, so another
 * account could plant code in a build; one that another account owns could hold such code, so it is refused. A
 * directory with a key records it in `<dir>.owner` and is refused when another key is recorded there, since the
 * short names of different areas can collide.
 */
function makePrivateWindowsDirs(dirs: Array<[dir: string, key?: string]>): void {
  try {
    getExecutor().runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PRIVATE_DIRS], {
      input: dirs.map((entry) => entry.join('\t')).join('\n'),
      timeoutMs: 60_000,
    });
  } catch (error) {
    const reason = (error instanceof Error ? error.message : String(error)).trim().split('\n').at(-1);
    throw new Error(`Could not prepare the private Windows build directories: ${reason}`, { cause: error });
  }
}

/**
 * Creates the checkout directory `src` of `area`. On Windows it is a junction to a private `windowsShortDir`, and the
 * client's Gradle home is made private too; an area whose `src` is a directory keeps it.
 */
function ensureCheckout(area: string, src: string): void {
  const stat = lstatSync(src, { throwIfNoEntry: false });
  if (process.platform === 'win32') {
    const linked = !stat || stat.isSymbolicLink();
    const realArea = realpathSync(area);
    const target = windowsShortDir(realArea);
    const gradleHome = process.env.GRADLE_USER_HOME;
    const dirs: Array<[dir: string, key?: string]> = [[dirname(target)]];
    if (linked) dirs.push([target, windowsShortDirKey('checkout', realArea)]);
    if (gradleHome) dirs.push([gradleHome, windowsShortDirKey('gradle', dirname(dirname(area)))]);
    makePrivateWindowsDirs(dirs);
    if (!linked) return;
    let current: string | null = null;
    try {
      current = realpathSync(src);
    } catch {}
    if (current?.toLowerCase() === target.toLowerCase()) return;
    if (stat) rmSync(src, { force: true });
    symlinkSync(target, src, 'junction');
    return;
  }
  mkdirSync(src, { recursive: true });
}

interface MirrorRecord {
  [path: string]: { sha256: string; kind: ManifestEntry['kind']; mtimeMs: number; size: number };
}

async function materialize(job: WorkerJob, src: string): Promise<{ written: number; removed: number }> {
  const recordFile = join(job.area, 'mirror.json');
  let previous: MirrorRecord = {};
  try {
    previous = JSON.parse(readFileSync(recordFile, 'utf8')) as MirrorRecord;
  } catch {}
  if (!existsSync(join(src, '.git'))) {
    git(src, ['init', '--quiet'], { write: true, timeoutMs: 30_000 });
    git(src, ['config', 'core.excludesFile', '/dev/null'], { write: true, timeoutMs: 30_000 });
  }
  git(src, ['read-tree', '--empty'], { write: true, timeoutMs: 30_000 });
  let retained: string[] = [];
  if (job.native) {
    if (job.native.provider === 'gradle') {
      const declaration = gradleOffloadInputs(job.native.inputs);
      validateGradleManifest(job.project, declaration, job.manifest);
      let receipt: { project?: unknown; directories?: unknown } = {};
      try {
        receipt = JSON.parse(readFileSync(join(job.area, 'gradle-outputs.json'), 'utf8'));
      } catch {}
      const allowed = [...declaration.outputs, ...gradleStateDirectories(job.project)];
      if (receipt.project === job.project && Array.isArray(receipt.directories))
        retained = allowed.filter((path) => (receipt.directories as unknown[]).includes(path));
      retained = await nativeGradleOutputs(
        src,
        { complete: true, ignored: [], outputs: retained },
        retained.map((path) => join(src, path)),
      );
    }
    const keep = new Set(
      job.manifest.flatMap((entry) => {
        const parts = entry.path.split('/');
        return parts.map((_, index) => parts.slice(0, index + 1).join('/'));
      }),
    );
    const removeUnknown = (directory: string, prefix: string) => {
      for (const name of readdirSync(directory)) {
        if (!prefix && name === '.git') continue;
        const path = prefix ? `${prefix}/${name}` : name;
        const absolute = join(directory, name);
        if (retained.includes(path)) continue;
        if (!keep.has(path) && !retained.some((output) => output.startsWith(`${path}/`)))
          rmSync(absolute, { recursive: true, force: true });
        else if (lstatSync(absolute).isDirectory()) removeUnknown(absolute, path);
      }
    };
    removeUnknown(src, '');
  }
  const next: MirrorRecord = {};
  const wanted = new Set<string>();
  let written = 0;
  for (const entry of job.manifest.toSorted((a, b) => a.path.split('/').length - b.path.split('/').length)) {
    wanted.add(entry.path);
    const target = join(src, entry.path);
    const known = previous[entry.path];
    let stat = null;
    try {
      stat = lstatSync(target);
    } catch {}
    if (entry.kind === 'directory' && stat?.isDirectory()) {
      next[entry.path] = { sha256: entry.sha256, kind: entry.kind, mtimeMs: stat.mtimeMs, size: stat.size };
      continue;
    }
    if (
      known &&
      stat &&
      (!job.native ||
        ((entry.kind === 'link' ? stat.isSymbolicLink() : stat.isFile()) &&
          createHash('sha256')
            .update(entry.kind === 'link' ? readlinkSync(target) : readFileSync(target))
            .digest('hex') === entry.sha256 &&
          (entry.kind === 'link' || (stat.mode & 0o111) === (entry.kind === 'exec' ? 0o111 : 0)))) &&
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
    if (entry.kind === 'directory') {
      mkdirSync(target);
    } else if (entry.kind === 'link') {
      symlinkSync(readFileSync(blob, 'utf8'), target);
    } else {
      copyFileSync(blob, target, constants.COPYFILE_FICLONE);
      chmodSync(target, entry.kind === 'exec' ? 0o755 : 0o644);
    }
    const after = lstatSync(target);
    next[entry.path] = { sha256: entry.sha256, kind: entry.kind, mtimeMs: after.mtimeMs, size: after.size };
    written += 1;
  }
  if (job.native) {
    const indexed = job.manifest.filter((entry) => entry.kind !== 'directory').map((entry) => `${entry.path}\0`);
    if (indexed.length)
      git(src, ['update-index', '--add', '--info-only', '-z', '--stdin'], {
        write: true,
        input: indexed.join(''),
        timeoutMs: 120_000,
      });
  }
  const untracked = job.native
    ? []
    : git(src, ['ls-files', '-z', '-o', '--exclude-standard'], { untrimmed: true, timeoutMs: 120_000 })
        .split('\0')
        .filter(Boolean);
  let removed = 0;
  for (const path of new Set([...untracked, ...Object.keys(previous)])) {
    if (
      wanted.has(path) ||
      retained.some((output) => output === path || output.startsWith(`${path}/`)) ||
      !realParents(src, path)
    )
      continue;
    try {
      rmSync(join(src, path), { force: true, ...(job.native ? { recursive: true } : {}) });
      removed += 1;
    } catch {}
  }
  const tmp = `${recordFile}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(next));
  renameSync(tmp, recordFile);
  return { written, removed };
}

/**
 * Puts the Node that `root`, or the nearest directory above it in `src`, pins first on this worker's `PATH`, and
 * reports which Node the build runs on.
 */
function useProjectNode(root: string, src: string): void {
  const node = withProjectNode(root, process.env, { top: src });
  if (node.pinned) process.env.PATH = node.env.PATH;
  note(
    'deps',
    node.pinned ? projectNodeLine(node.pinned) : `Node ${pathNodeVersion(process.env) ?? 'unknown'} on PATH`,
  );
}

/**
 * Names the `node` first on this worker's `PATH` in `<iosDir>/.xcode.env.local`. React Native's `with-environment.sh`
 * runs Xcode's script phases on that file's `NODE_BINARY`, and its CocoaPods setup writes the file only when it is
 * missing, so a file left from an earlier job, or one recording a Homebrew Cellar path, would otherwise win.
 */
function useXcodeNode(iosDir: string): void {
  const node = (process.env.PATH ?? '')
    .split(delimiter)
    .filter(Boolean)
    .map((dir) => join(dir, 'node'))
    .find((path) => statSync(path, { throwIfNoEntry: false })?.isFile());
  if (!node || !existsSync(iosDir)) return;
  const file = join(iosDir, '.xcode.env.local');
  const line = `export NODE_BINARY='${node.replaceAll("'", "'\\''")}'`;
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const next = /^export NODE_BINARY=.*$/m.test(text)
    ? text.replace(/^export NODE_BINARY=.*$/gm, () => line)
    : `${text}${text && !text.endsWith('\n') ? '\n' : ''}${line}\n`;
  if (next !== text) writeFileSync(file, next);
}

/** Installs JavaScript dependencies when the lockfile, or the install command, changed since the last install. */
async function ensureDependencies(job: WorkerJob, src: string): Promise<void> {
  const install = dependencyInstall(src, job.packageName, relative(src, realpathSync(join(src, job.project))));
  if (!install) return;
  const { command, args, digest, lockfile } = install;
  const marker = join(job.area, 'dependencies');
  const installed = () => writeFileSync(join(job.area, 'lockfile'), lockfile);
  if (existsSync(join(src, job.project, 'node_modules')) && existsSync(marker)) {
    if (readFileSync(marker, 'utf8') === digest) return installed();
  }
  note('deps', `${command} ${args.join(' ')}`);
  const child = getExecutor().spawn(command, args, {
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
  if (code !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${code}: ${tail.join(' | ')}`);
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
    ) as { devices?: Record<string, Array<{ udid: string; deviceTypeIdentifier: string; isAvailable: boolean }>> };
    const device = (listed.devices?.[runtime] ?? []).find(availableIphone);
    return device ? `id=${device.udid}` : null;
  } catch {
    return null;
  }
}

/**
 * Writes `name` under `dir` to `archive` as a gzip tarball at compression level 1. Node does the gzip because tar's
 * compression-level flags differ between bsdtar (macOS, Windows) and GNU tar (Linux).
 */
async function packArchive(archive: string, dir: string, name: string): Promise<void> {
  const child = getExecutor().spawn('tar', ['-cf', '-', '-C', dir, name], { stdio: ['ignore', 'pipe', 'pipe'] });
  const tarball = child.stdout;
  if (!tarball) throw new Error('tar opened no output stream.');
  const stderr: string[] = [];
  child.stderr?.on('data', (chunk: Buffer) => stderr.push(String(chunk)));
  let spawnError: Error | null = null;
  const exited = new Promise<number | null>((resolve) => {
    child.once('error', (error) => {
      spawnError = error;
      resolve(null);
    });
    child.once('close', resolve);
  });
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), 600_000);
  try {
    await pipeline(tarball, createGzip({ level: 1 }), createWriteStream(archive), { signal: timeout.signal });
  } catch (error) {
    child.kill('SIGKILL');
    await exited;
    throw timeout.signal.aborted ? new Error('Packing the artifact did not finish within 10 minutes.') : error;
  } finally {
    clearTimeout(timer);
  }
  const code = await exited;
  if (spawnError) throw spawnError;
  if (code !== 0) throw new Error(`tar exited with ${code}: ${stderr.join('').trim().slice(-500)}`);
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
  ensureCheckout(job.area, join(job.area, 'src'));
  const src = realpathSync(join(job.area, 'src'));
  const root = join(src, job.project);

  const log = relayWriter(join(job.area, 'build.ndjson'));

  const mirrored = await time('syncMs', () => materialize(job, src));
  const realSrc = realpathSync(src);
  const realRoot = realpathSync(root);
  if (realRoot !== realSrc && !realRoot.startsWith(`${realSrc}${sep}`))
    return failed('bad-project', `${job.project} leaves the checkout.`);
  note('sync', `${job.manifest.length} files, ${mirrored.written} written, ${mirrored.removed} removed`);
  let fingerprint: string | null;
  let compiled: Compiled;
  if (job.native?.provider === 'gradle') {
    if (job.platform !== 'android' || job.expectedFingerprint !== null)
      return failed(
        'unsupported-provider',
        'Native Gradle needs an Android request with no reusable artifact identity.',
      );
    const selected = projectRegistry.selectAndroid(root);
    if ('problem' in selected || selected.id !== 'native-android')
      return failed('provider-mismatch', 'The transferred project did not select the native Android integration.');
    if (!(await verifyGradleTransfer(src, job.project, job.native.inputs, job.manifest, job.native.sourceDigest)))
      return failed('source-mismatch', 'The materialized native inputs do not match the source transfer.');
    compiled = await compileNativeAndroid(job, root, log, time);
    if (!compiled.ok) return failed(compiled.code, compiled.message);
    try {
      if (!(await verifyGradleTransfer(src, job.project, job.native.inputs, job.manifest, job.native.sourceDigest)))
        throw new Error('The native source changed while the worker compiled it.');
    } catch (error) {
      if (compiled.temporary) rmSync(compiled.temporary, { recursive: true, force: true });
      return failed('source-moved', (error as Error).message);
    }
    fingerprint = null;
  } else if (job.native) {
    if (job.platform !== 'ios' || job.native.provider !== 'xcode')
      return failed('unsupported-provider', 'The worker does not implement this native provider.');
    const selected = projectRegistry.selectIos(root);
    if ('problem' in selected || selected.id !== 'native-xcode')
      return failed('provider-mismatch', 'The transferred project did not select the native Xcode integration.');
    let metadataDirectories: string[];
    try {
      metadataDirectories = nativeXcodeMetadataDirectories(
        selectNativeXcodeProject(root, job.scheme ?? undefined, job.configuration ?? undefined),
      );
      if (!(await verifyNativeTransfer(src, job.manifest, job.native.sourceDigest, metadataDirectories)))
        return failed('source-mismatch', 'The materialized native inputs do not match the source transfer.');
    } catch (error) {
      return failed('source-mismatch', (error as Error).message);
    }
    const native = job.native;
    const refused = await time('fingerprintMs', () =>
      nativeIdentityRefusal(job, native, root, () => selected.load({})),
    );
    if (refused) return failed('identity-mismatch', refused);
    compiled = await compileNativeIos(job, root, log, time);
    if (!compiled.ok) return failed(compiled.code, compiled.message);
    try {
      if (!(await verifyNativeTransfer(src, job.manifest, job.native.sourceDigest, metadataDirectories)))
        throw new Error('The native source changed while the worker compiled it.');
    } catch (error) {
      if (compiled.temporary) rmSync(compiled.temporary, { recursive: true, force: true });
      return failed('source-moved', (error as Error).message);
    }
    fingerprint = job.expectedFingerprint;
  } else if (job.platform === 'macos') {
    fingerprint = await time('fingerprintMs', () => manifestDigest(job.manifest));
    if (fingerprint !== job.expectedFingerprint)
      return failed(
        'fingerprint-mismatch',
        `the manifest there fingerprints ${fingerprint.slice(0, 12)}, here ${job.expectedFingerprint?.slice(0, 12)}`,
      );
    compiled = await workerOperation(root, (context) => compileMacos(context, job, root, log, time));
    if (!compiled.ok) return failed(compiled.code, compiled.message);
  } else {
    useProjectNode(realRoot, realSrc);
    const nodeFailed = (code: string, message: string) =>
      failed(code, [message, unmetNodePin(realRoot, process.env, { top: realSrc })].filter(Boolean).join(' '));
    try {
      await time('depsMs', () => ensureDependencies(job, src));
    } catch (error) {
      return nodeFailed('deps-failed', (error as Error).message);
    }

    const platform = job.platform;
    let iosProject: IosProjectDir;
    try {
      iosProject = iosProjectDirSetting({ ios: { projectPath: job.iosProjectPath ?? undefined } }, realRoot);
    } catch (error) {
      return failed('bad-request', (error as Error).message);
    }
    let androidLayout: AndroidLayout;
    try {
      androidLayout = androidLayoutSetting(
        { android: { gradleRoot: job.android?.gradleRoot ?? undefined, module: job.android?.module ?? undefined } },
        realRoot,
        realSrc,
      );
    } catch (error) {
      return failed('bad-request', (error as Error).message);
    }
    const initial = await time('fingerprintMs', () =>
      fingerprintProject(realRoot, { platform, iosProjectPath: iosProject.relative, androidLayout }),
    );
    if (!initial) return failed('no-fingerprint', 'The remote machine could not fingerprint the project.');
    const plan = planPrebuild(realRoot, platform, {
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
      recordPrebuild(realRoot, platform, null);
      const result = await time('prebuildMs', () =>
        runPrebuild(realRoot, platform, log, { clean: plan === 'regenerate' }),
      );
      if (result?.failed) return nodeFailed('prebuild-failed', result.reason ?? 'expo prebuild failed.');
      mutations.push('prebuild');
    }
    if (platform === 'ios') {
      useXcodeNode(iosProject.dir);
      const podState = readPodState(realRoot, iosProject.dir);
      const pods = podAction(podState, podsAreStale(podState.lockText, podState.manifestText, podState.dir));
      if (pods.install) {
        note('pods', `${pods.reason ?? 'Pods are stale'} -> pod install`);
        const result = await time('podsMs', () =>
          runPodInstall(realRoot, log, { directory: iosProject.dir, onHeartbeat: (line) => note('pods', line) }),
        );
        if (result?.failed) return failed('pods-failed', result.reason ?? 'pod install failed.');
        mutations.push('pods');
      }
    }
    fingerprint = initial.hash;
    if (mutations.length) {
      const after = await time('fingerprintMs', () =>
        refingerprintAfterMutation({
          projectRoot: realRoot,
          platform,
          previousHash: initial.hash,
          iosProjectPath: iosProject.relative,
          androidLayout,
        }),
      );
      if (!after) return failed('no-fingerprint', `No fingerprint after ${mutations.join(', ')}.`);
      fingerprint = after.hash;
      if (mutations.includes('prebuild')) recordPrebuild(realRoot, platform, after.hash);
    }
    if (fingerprint !== job.expectedFingerprint) {
      return failed(
        'fingerprint-mismatch',
        `the checkout there fingerprints ${fingerprint.slice(0, 12)}, here ${job.expectedFingerprint?.slice(0, 12)}`,
      );
    }

    const tools = job.cacheArtifact ? await reactNativeArtifactToolchain(platform, realRoot) : null;
    const query = tools ? reactNativeBuildQuery(job, fingerprint, job.project, tools) : null;
    const receipt = query ? reactNativeArtifactReceipt(query, tools) : null;
    compiled =
      platform === 'android'
        ? await compileAndroid(job, realRoot, log, time, androidLayout)
        : await compileIos(job, realRoot, log, time);
    if (!compiled.ok) return failed(compiled.code, compiled.message);
    const builtFingerprint = fingerprint;
    const settled = await time('fingerprintMs', () =>
      refingerprintAfterMutation({
        projectRoot: realRoot,
        platform,
        previousHash: builtFingerprint,
        iosProjectPath: iosProject.relative,
        androidLayout,
      }),
    );
    if (!settled || settled.moved) return failed('fingerprint-moved', 'The inputs changed during the build there.');
    const after =
      query && receipt
        ? reactNativeArtifactReceipt(query, await reactNativeArtifactToolchain(platform, realRoot))
        : null;
    if (receipt && after && isDeepStrictEqual(receipt, after)) compiled.reactNativeArtifact = receipt;
  }
  try {
    const out = join(job.area, 'out', job.job);
    if (job.platform !== 'macos') rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    const archive = join(out, 'app.tgz');
    const name = basename(compiled.path);
    if (job.platform === 'ios' || job.platform === 'android')
      cpSync(compiled.path, join(out, name), {
        recursive: true,
        verbatimSymlinks: true,
        mode: constants.COPYFILE_FICLONE,
      });
    await time('packageMs', () => packArchive(archive, dirname(compiled.path), name));
    const sha256 = await time('packageMs', () => sha256Of(archive));
    return {
      ok: true,
      artifact: { path: archive, name, size: statSync(archive).size, sha256 },
      fingerprint,
      ...(compiled.androidPackage ? { androidPackage: compiled.androidPackage } : {}),
      ...(job.native ? { sourceDigest: job.native.sourceDigest } : {}),
      ...(compiled.cacheArtifact ? { cacheArtifact: compiled.cacheArtifact } : {}),
      ...(compiled.reactNativeArtifact ? { reactNativeArtifact: compiled.reactNativeArtifact } : {}),
      ...(compiled.swiftpmArtifact ? { swiftpmArtifact: compiled.swiftpmArtifact } : {}),
      compilationCache: compiled.cache,
      timings,
    };
  } finally {
    if (compiled.temporary) rmSync(compiled.temporary, { recursive: true, force: true });
  }
}

type Timer = <T>(key: keyof WorkerTimings, run: () => T | Promise<T>) => Promise<T>;

type Compiled =
  | {
      ok: true;
      path: string;
      cache: CompilationCacheActivity | CcacheActivity | Record<string, never>;
      temporary?: string;
      androidPackage?: string;
      cacheArtifact?: { identity: { hash: string; key: string }; receipt: NativeGradleArtifactReceipt };
      reactNativeArtifact?: NonNullable<ReturnType<typeof reactNativeArtifactReceipt>>;
      swiftpmArtifact?: Awaited<ReturnType<typeof swiftpmWorkerArtifactSnapshot>>;
    }
  | { ok: false; code: string; message: string };

function differingParameters(here: unknown, there: unknown, path: string): string[] {
  if (JSON.stringify(here) === JSON.stringify(there)) return [];
  if (!isJsonObject(here) || !isJsonObject(there)) return [path];
  return [...new Set([...Object.keys(here), ...Object.keys(there)])]
    .toSorted()
    .flatMap((key) => differingParameters(here[key], there[key], `${path}.${key}`));
}

function unused(): never {
  throw new Error('The native identity check does not prepare or compile.');
}

async function nativeIdentityRefusal(
  job: WorkerJob,
  native: Extract<WorkerJob['native'], { provider: 'xcode' }>,
  root: string,
  load: () => Promise<IosProject>,
): Promise<string | null> {
  if (!job.optimizations) return 'The native Xcode build has no compiler options.';
  try {
    const recipe = (await load()).artifact({
      root,
      logFile: join(job.area, 'build.ndjson'),
      configuration: job.configuration,
      ...(job.scheme ? { buildScheme: job.scheme } : {}),
      target: {
        udid: null,
        destination: 'generic/platform=iOS Simulator',
        sdk: 'iphonesimulator',
        arch: native.arch,
        keyArch: native.arch,
        offloadRuntime: () => job.runtime,
        offloadRefusal: null,
      },
      device: null,
      optimizations: job.optimizations,
      cache: { read: true, write: true, remote: false },
      phase: unused,
      note: unused,
      logWriter: unused,
      estimates: unused,
      step: unused,
      setPodsMs: unused,
    });
    const identity = await recipe.identity();
    if ('cacheIneligible' in identity) return `This Mac cannot key the native build: ${identity.cacheIneligible}`;
    if (identity.key === native.cacheKey) return null;
    const here = recipe.offload?.request(job.runtime ?? '').native?.snapshot.parameters;
    const differing = differingParameters(native.parameters, here, 'parameters');
    return differing.length
      ? `This Mac keys the native build differently in ${differing.join(', ')}.`
      : 'This Mac keys the native build differently from the same parameters.';
  } catch (error) {
    return `This Mac cannot key the native build: ${(error as Error).message}`;
  }
}

function workerOperation<T>(root: string, fn: (context: StimContext) => Promise<T>): Promise<T> {
  const context = processContext(root, new AbortController().signal);
  return withAmbientContext(context, () => fn(context));
}

async function compileNativeIos(job: WorkerJob, root: string, log: NdjsonWriter, time: Timer): Promise<Compiled> {
  if (job.native?.provider !== 'xcode' || !job.optimizations)
    return { ok: false, code: 'bad-request', message: 'The native Xcode build has no compiler options.' };
  const native = job.native;
  for (const key of ['compilationCache', 'swiftCompilationCache', 'prefixMapping'] as const) {
    const value = job.optimizations[key];
    writeConfigSetting({ scope: 'workspace', projectPath: root }, `optimizations.ios.${key}`, value ?? undefined);
  }
  note('build', `native Xcode ${job.configuration ?? 'Debug'}`);
  const logFile = join(workspaceLogsDir(root), 'build-ios.ndjson');
  try {
    rmSync(logFile, { force: true });
    const built = await time('buildMs', () =>
      workerOperation(root, (context) =>
        buildIosOperation(context, root, {
          scheme: job.scheme ?? undefined,
          configuration: job.configuration ?? undefined,
          arch: native.arch ?? 'all',
          remoteBuild: 'local',
        }),
      ),
    );
    if (built.cacheKey !== native.cacheKey || built.cacheSkipped) {
      rmSync(dirname(built.appPath), { recursive: true, force: true });
      return {
        ok: false,
        code: 'fingerprint-mismatch',
        message: 'The worker resolved a different native artifact identity.',
      };
    }
    return { ok: true, path: built.appPath, cache: built.compilationCache, temporary: dirname(built.appPath) };
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === COMPILATION_CACHE_CORRUPT) {
      const remedy = 'remedy' in error && typeof error.remedy === 'string' ? ` ${error.remedy}` : '';
      return { ok: false, code: COMPILATION_CACHE_CORRUPT, message: `${error.message}${remedy}` };
    }
    return { ok: false, code: 'native-build-failed', message: (error as Error).message };
  } finally {
    if (existsSync(logFile)) for (const record of parseNdjsonText(readFileSync(logFile, 'utf8'))) log.write(record);
  }
}

async function validateNativeAndroidOutputs(job: WorkerJob, root: string): Promise<void> {
  if (job.native?.provider !== 'gradle') throw new Error('A native Gradle source declaration is required.');
  try {
    const src = realpathSync(join(job.area, 'src'));
    const model = JSON.parse(
      readFileSync(
        join(
          workspaceDir(root),
          'gradle-build',
          `native-apk-${encodeURIComponent(job.android?.variant ?? 'debug')}.json`,
        ),
        'utf8',
      ),
    ) as { buildDirectories?: unknown };
    const outputs = await nativeGradleOutputs(src, job.native.inputs, model.buildDirectories);
    if (!(await verifyGradleTransfer(src, job.project, job.native.inputs, job.manifest, job.native.sourceDigest)))
      throw new Error('The native source changed while the worker compiled it.');
    const directories = [
      ...outputs,
      ...gradleStateDirectories(job.project).filter((path) =>
        lstatSync(join(src, path), { throwIfNoEntry: false })?.isDirectory(),
      ),
    ];
    const receipt = join(job.area, 'gradle-outputs.json');
    const tmp = `${receipt}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ project: job.project, directories }));
    renameSync(tmp, receipt);
  } catch (error) {
    throw Object.assign(new Error((error as Error).message), { code: 'source-moved' });
  }
}

async function compileNativeAndroid(job: WorkerJob, root: string, log: NdjsonWriter, time: Timer): Promise<Compiled> {
  const options = job.android;
  if (!options) return { ok: false, code: 'bad-request', message: 'The native Gradle job has no build options.' };
  for (const key of ['compilerCache', 'pch', 'gradleBuildCache'] as const)
    writeConfigSetting({ scope: 'workspace', projectPath: root }, `optimizations.android.${key}`, options[key]);
  const idleMs = job.gradleDaemonIdleMs ?? 0;
  limitDaemonIdle(idleMs > 0 ? idleMs : 60_000);
  const gradlew = join(root, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
  const stop = () => {
    stopGradleDaemons(gradlew, 4000);
    process.exit(143);
  };
  process.once('SIGTERM', stop);
  const logFile = join(workspaceLogsDir(root), 'build-android.ndjson');
  let cacheArtifact: { identity: { hash: string; key: string }; receipt: NativeGradleArtifactReceipt } | undefined;
  note('build', `native Gradle ${options.variant ?? 'debug'}`);
  try {
    rmSync(logFile, { force: true });
    const built = await time('buildMs', () =>
      workerOperation(root, (context) =>
        buildAndroidOperation(
          context,
          root,
          {
            variant: options.variant ?? undefined,
            abi: (options.abi ?? 'all') as 'arm64-v8a' | 'armeabi-v7a' | 'x86' | 'x86_64' | 'all',
            remoteBuild: 'local',
          },
          {
            cachePolicy:
              job.native?.provider === 'gradle' && job.native.cache
                ? job.native.cache
                : { read: false, write: false, remote: false },
            artifactScope: {
              key:
                job.native?.provider === 'gradle'
                  ? nativeGradleWorkerScope(job.native.sourceDigest, job.native.inputs)
                  : 'null',
              validate: () => validateNativeAndroidOutputs(job, root),
              record: (identity, receipt) => {
                cacheArtifact = { identity, receipt };
              },
            },
          },
        ),
      ),
    );
    if (!built.androidPackage) {
      rmSync(dirname(built.apkPath), { recursive: true, force: true });
      return {
        ok: false,
        code: 'invalid-package',
        message: 'The native Gradle worker returned no verified APK package.',
      };
    }
    return {
      ok: true,
      path: built.apkPath,
      temporary: dirname(built.apkPath),
      cache: built.ccache,
      androidPackage: built.androidPackage,
      ...(cacheArtifact && cacheArtifact.identity.key === built.cacheKey ? { cacheArtifact } : {}),
    };
  } catch (error) {
    return {
      ok: false,
      code:
        error instanceof Error && 'code' in error && error.code === 'source-moved'
          ? 'source-moved'
          : 'native-build-failed',
      message: (error as Error).message,
    };
  } finally {
    process.off('SIGTERM', stop);
    if (idleMs <= 0) stopGradleDaemons(gradlew, 60_000);
    if (existsSync(logFile)) for (const record of parseNdjsonText(readFileSync(logFile, 'utf8'))) log.write(record);
  }
}

async function compileMacos(
  context: StimContext,
  job: WorkerJob,
  root: string,
  log: NdjsonWriter,
  time: Timer,
): Promise<Compiled> {
  const options = job.macos;
  if (!options) return { ok: false, code: 'bad-request', message: 'The job has no SwiftPM options.' };
  const src = join(job.area, 'src');
  const scratch = join(job.area, 'macos', job.project.replaceAll('/', '_') || 'root');
  const run = async (args: string[], capture = false): Promise<string> => {
    const child = getExecutor().spawn('swift', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let firstError: string | null = null;
    const tail: string[] = [];
    const write = (msg: string) => {
      const plain = stripAnsi(msg);
      if (firstError === null && /\.swift:\d+:\d+: error:/.test(plain)) firstError = plain;
      tail.push(plain);
      if (tail.length > 3) tail.shift();
      note('build', msg);
      log.write({ src: 'build', platform: 'macos', level: 'debug', msg });
    };
    child.stdout?.on('data', (chunk: Buffer) => {
      if (capture) stdout += chunk.toString('utf8');
    });
    if (child.stdout) logLines(child.stdout, write);
    if (child.stderr) logLines(child.stderr, write);
    await new Promise<void>((done, reject) => {
      child.once('error', reject);
      child.once('close', (code) =>
        code === 0 ? done() : reject(new Error(firstError ?? (tail.join(' | ') || `swift build failed (${code})`))),
      );
    });
    return stdout.trim();
  };
  try {
    const extras = resolveBundleExtras(src, src, options.resources, options.assetCatalog);
    const query: BuildSwiftpmArtifactQuery | null =
      job.cacheArtifact && options.artifactInputs && job.expectedFingerprint && job.stimBuild
        ? {
            project: job.project,
            sourceDigest: job.expectedFingerprint,
            stimBuild: job.stimBuild,
            inputs: options.artifactInputs,
            build: {
              product: options.product,
              infoPlist: options.infoPlist,
              resources: options.resources ?? {},
              assetCatalog: options.assetCatalog ?? null,
            },
          }
        : null;
    const snapshot = async () =>
      query
        ? swiftpmWorkerArtifactSnapshot(root, query, await readSwiftpmWorkerToolchain(context, root), context.env)
        : null;
    let before: Awaited<ReturnType<typeof snapshot>> = null;
    try {
      before = await snapshot();
    } catch (error) {
      context.signal.throwIfAborted();
      note('build', `SwiftPM artifact inventory unavailable: ${String(error)}`);
    }
    return await time('buildMs', async () => {
      await run([
        'build',
        '-c',
        'debug',
        '--product',
        options.product,
        '--scratch-path',
        scratch,
        '--cache-path',
        job.swiftpmCache,
      ]);
      const bin = await run(
        ['build', '-c', 'debug', '--scratch-path', scratch, '--cache-path', job.swiftpmCache, '--show-bin-path'],
        true,
      );
      const bundle = join(job.area, 'out', job.job, `${options.product}.app`);
      await stageBundle(context, root, options.product, options.infoPlist, bin, bundle, options.bundleId, extras);
      let swiftpmArtifact: Awaited<ReturnType<typeof snapshot>> = null;
      if (before) {
        try {
          const after = await snapshot();
          if (after?.identity.hash === before.identity.hash) swiftpmArtifact = after;
          else note('build', 'SwiftPM inputs changed during the build; not retaining its artifact.');
        } catch (error) {
          context.signal.throwIfAborted();
          note('build', `SwiftPM artifact inventory skipped: ${String(error)}`);
        }
      }
      return { ok: true, path: bundle, cache: {}, ...(swiftpmArtifact ? { swiftpmArtifact } : {}) };
    });
  } catch (error) {
    return { ok: false, code: 'swift-failed', message: (error as Error).message };
  }
}

async function compileIos(job: WorkerJob, root: string, log: NdjsonWriter, time: Timer): Promise<Compiled> {
  const runtime = job.runtime ?? '';
  const target = destination(runtime);
  if (!target)
    return { ok: false, code: 'no-runtime', message: `There is no iPhone simulator on ${runtime} to build for.` };
  note('build', `xcodebuild for ${runtime}`);
  const built = await time('buildMs', () =>
    buildIos({
      root,
      iosDir: iosProjectDirSetting({ ios: { projectPath: job.iosProjectPath ?? undefined } }, root).dir,
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
    if (built.compilationCacheCorruption) {
      const report = await clearCorruptCompilationCache(built.compilationCacheCorruption, root);
      return { ok: false, code: report.code, message: `${report.message} ${report.remedy}` };
    }
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
function stopGradleDaemons(gradlew: string, timeoutMs: number): void {
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

async function compileAndroid(
  job: WorkerJob,
  root: string,
  log: NdjsonWriter,
  time: Timer,
  layout: AndroidLayout,
): Promise<Compiled> {
  const options = job.android;
  if (!options) return { ok: false, code: 'bad-request', message: 'The job has no Gradle options.' };
  const idleMs = job.gradleDaemonIdleMs ?? 0;
  const keepDaemon = idleMs > 0;
  limitDaemonIdle(keepDaemon ? idleMs : 60_000);
  const onNote = (line: string) => note('build', line);
  const stop = () => {
    stopGradleDaemons(gradlewPath(layout), 4000);
    process.exit(143);
  };
  process.once('SIGTERM', stop);
  note(
    'build',
    `gradle ${layout.custom ? `${layout.module}:` : ''}${assembleTaskFor(options.variant)} for ${options.abi ?? 'every ABI'}`,
  );
  try {
    const built = await time('buildMs', () =>
      buildAndroid(
        { root, logWriter: log, variant: options.variant, abi: options.abi, layout },
        {
          buildCache: options.gradleBuildCache,
          pch: options.pch,
          compilerCacheDisabled: options.compilerCache === 'none',
          ccache: options.compilerCache === 'ccache' ? resolveCcache({ root, layout, onNote }) : null,
          onHeartbeat: onNote,
          onNote,
        },
      ),
    );
    if (!built.ok) {
      const first = built.diagnostics[0]?.message;
      return { ok: false, code: built.code, message: first ?? (built.lastLines.slice(-3).join(' | ') || built.reason) };
    }
    const androidPackage = built.androidPackage ?? apkPackage(await dumpApkManifest(built.apkPath));
    return {
      ok: true,
      path: built.apkPath,
      cache: built.ccache ?? CCACHE_UNAVAILABLE,
      ...(androidPackage ? { androidPackage } : {}),
    };
  } finally {
    process.off('SIGTERM', stop);
    if (!keepDaemon) stopGradleDaemons(gradlewPath(layout), 60_000);
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode === 'offer') return emit(workerToolchain(process.argv[3] ?? null));
  if (mode === 'offer-native-xcode') return emit(workerToolchain(null, 'xcode'));
  if (mode === 'offer-native-gradle') return emit(workerToolchain(null, 'gradle'));
  if (mode === 'native-gradle-artifact') {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const input: {
      root: string;
      receipt: NativeGradleArtifactReceipt;
      sourceDigest: string;
      inputs: GradleOffloadInputs;
      android: BuildAndroidOptions;
    } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!/^[a-f0-9]{64}$/.test(input.sourceDigest)) throw new Error('The completed transfer identity is invalid.');
    gradleOffloadInputs(input.inputs);
    if (input.android) {
      const { android, receipt } = input;
      if (
        (android.variant !== null && android.variant !== receipt.build.variant) ||
        (android.abi === 'all' ? null : android.abi) !== receipt.abi ||
        android.compilerCache !== receipt.build.compilerCache ||
        android.gradleBuildCache !== receipt.build.gradleBuildCache ||
        android.pch !== receipt.build.pch ||
        receipt.build.cas !== null
      )
        throw new Error('The completed Gradle build choices do not match this artifact request.');
    }
    const snapshot = await workerOperation(input.root, (context) =>
      nativeGradleArtifactSnapshotFromReceipt(input.root, input.receipt, context.env, context.signal),
    );
    return emit({
      identity: nativeGradleWorkerArtifactIdentity(
        snapshot.hash,
        nativeGradleWorkerScope(input.sourceDigest, input.inputs),
        input.receipt.build.variant ?? 'debug',
        input.receipt.abi,
      ),
    });
  }
  if (mode === 'swiftpm-artifact') {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const input: { root: string; query: BuildSwiftpmArtifactQuery; receipt: SwiftpmArtifactReceipt } = JSON.parse(
      Buffer.concat(chunks).toString('utf8'),
    );
    const checkout = existsSync(input.root);
    if (!checkout && input.receipt.checkoutRequired !== false) return emit({ identity: null });
    const identity = await workerOperation(input.root, async (context) =>
      swiftpmArtifactFromReceipt(
        input.root,
        input.query,
        input.receipt,
        await readSwiftpmWorkerToolchain(context, checkout ? input.root : process.cwd()),
        context.env,
      ),
    );
    return emit({ identity });
  }
  if (mode === 'build') {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    const job = JSON.parse(Buffer.concat(chunks).toString('utf8')) as WorkerJob;
    return emit({ type: 'result', ...(await build(job)) });
  }
  process.stderr.write(
    'usage: offload-worker offer | offer-native-xcode | offer-native-gradle | native-gradle-artifact | build < job.json\n',
  );
  process.exitCode = 2;
}

main().catch((error: unknown) => {
  emit({ type: 'result', ok: false, code: 'worker-crashed', message: String((error as Error)?.message ?? error) });
});
