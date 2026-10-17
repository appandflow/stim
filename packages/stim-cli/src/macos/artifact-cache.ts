import { cp, lstat, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  buildResolveTimeoutMs,
  buildUploadTimeoutMs,
  createFilesystemFileCache,
  loadCacheProvider,
  type FileCacheCapability,
} from '@stim-cli/cache';
import type { StimContext } from '@stim-cli/core';
import { cacheRoot } from '../cache/build-cache.ts';
import { register } from '../cache/cache-manifest.ts';
import { getExecutor } from '../exec.ts';
import { swiftpmArtifactSnapshot } from '../integrations/swiftpm-artifact-inputs.ts';
import type { MacosArtifactRecipe } from '../integrations/macos-project.ts';
import { artifactCachePolicy, resolveOptimizations } from '../optimizations.ts';
import {
  projectSettingsContextAsync,
  resolveCacheProviderConfig,
  settingValueAt,
  type SettingsObject,
} from '../workspace/settings.ts';
import { packMacosArtifact, unpackMacosArtifact } from './artifact-file.ts';
import { reidentifyBundle } from './stage.ts';
import { runCancellationSignal } from '../engine/native-run.ts';
import { trackReportResource } from '../report-runtime.ts';

async function providerCall<T>(
  call: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  context: StimContext,
  directory: string,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  const controller = new AbortController();
  const failure = Object.assign(
    new Error(`SwiftPM cache provider cleanup did not finish within 35 seconds. Retained ${directory}.`),
    {
      code: 'STIM_CLAIM_UNAVAILABLE',
      reportCleanup: true,
      remedy: 'Confirm that the provider has stopped using the retained directory before removing it and retrying.',
    },
  );
  const pending = Promise.resolve()
    .then(() => {
      controller.signal.throwIfAborted();
      return call(controller.signal);
    })
    .then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
  let close: () => void;
  const closed = new Promise<void>((settleClosed) => {
    close = settleClosed;
  });
  let cleanup: Promise<void> | undefined;
  const finish = () =>
    (cleanup ??= (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settled = await Promise.race([
        pending.then(() => true),
        new Promise<false>((settleDrain) => {
          timer = setTimeout(() => settleDrain(false), 35_000);
        }),
      ]).finally(() => clearTimeout(timer));
      if (!settled) throw failure;
      const result = await pending;
      if ('error' in result && result.error instanceof Error && 'reportCleanup' in result.error) throw result.error;
    })().finally(() => close()));
  let notifyAbort: () => void;
  const aborted = new Promise<{ aborted: true }>((settleAbort) => {
    notifyAbort = () => settleAbort({ aborted: true });
  });
  const childAborted = () => notifyAbort();
  controller.signal.addEventListener('abort', childAborted, { once: true });
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  trackReportResource(context, closed, finish, signal, failure);
  const deadline = setTimeout(() => controller.abort(), timeoutMs);
  if (signal.aborted) abort();
  const outcome = await Promise.race([pending, aborted]);
  clearTimeout(deadline);
  signal.removeEventListener('abort', abort);
  controller.signal.removeEventListener('abort', childAborted);
  await finish();
  signal.throwIfAborted();
  if ('aborted' in outcome) throw new Error('SwiftPM cache provider timed out.');
  if ('error' in outcome) throw outcome.error;
  return outcome.value;
}

const fileKey = (key: string) => `swiftpm/v1/${key}`;

async function contained(path: string, directory: string): Promise<void> {
  const rel = relative(await realpath(directory), await realpath(path));
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`) || !(await lstat(path)).isFile())
    throw new Error('The shared SwiftPM cache file is outside its download directory or is not a regular file.');
}

export interface MacosArtifactCache {
  identity(): Promise<{ hash: string; key: string }>;
  has(key: string): Promise<boolean>;
  restore(key: string, directory: string): Promise<{ bundle: string; tier: 'local' | 'provider' } | null>;
  store(key: string, bundle: string, directory: string): Promise<void>;
}

export function swiftpmArtifactCache(
  context: StimContext,
  root: string,
  settings: SettingsObject,
  recipe: Pick<MacosArtifactRecipe, 'product' | 'bundleId' | 'validateFetched'>,
  build: Parameters<typeof swiftpmArtifactSnapshot>[2],
): MacosArtifactCache | undefined {
  const declaration = settingValueAt(settings, 'macos.artifactInputs');
  if (!declaration) return undefined;
  const policy = artifactCachePolicy(resolveOptimizations(settings, context.env), true, false);
  if (!policy.read) return undefined;
  const activeSignal = () => runCancellationSignal(context) ?? context.signal;
  const localRoot = cacheRoot();
  const local = createFilesystemFileCache(join(localRoot, 'macos'));
  const storeLocal = async (key: string, sourcePath: string, signal: AbortSignal) => {
    register({
      dir: localRoot,
      registeredBy: root,
      name: 'Build cache',
      prune: 'entries',
      entriesDepth: 2,
      note: 'completed native artifacts keyed on build inputs',
    });
    await local.store({ key: fileKey(key), sourcePath, overwrite: true, signal });
  };
  let provider: Promise<FileCacheCapability | null> | undefined;
  const shared = () =>
    (provider ??= (async () => {
      const signal = activeSignal();
      if (!policy.remote) return null;
      const settingsContext = await projectSettingsContextAsync(root, undefined, {
        env: context.env,
        signal,
        declareFor: context,
      });
      const loaded = await loadCacheProvider({
        projectRoot: root,
        config: resolveCacheProviderConfig(settingsContext),
        env: context.env,
      });
      if (loaded.unavailable) throw new Error(loaded.unavailable);
      return loaded.provider?.files ?? null;
    })());
  const unpack = async (path: string, key: string, directory: string) => {
    const signal = activeSignal();
    const bundle = join(directory, 'Cached.app');
    await unpackMacosArtifact(path, key, bundle, signal);
    await recipe.validateFetched(bundle, recipe.bundleId);
    const binary = join(bundle, 'Contents', 'MacOS', recipe.product);
    const options = { timeoutMs: 30_000, signal, declareFor: context };
    const architecture = process.arch === 'x64' ? 'x86_64' : process.arch;
    const archs = await getExecutor().runFileAsync('xcrun', ['lipo', '-archs', binary], options);
    const platform = await getExecutor().runFileAsync(
      'xcrun',
      ['vtool', '-arch', architecture, '-show-build', binary],
      options,
    );
    if (!archs.trim().split(/\s+/).includes(architecture) || !/^\s*platform\s+MACOS\s*$/m.test(platform))
      throw new Error('The cached macOS executable does not match this platform and architecture.');
    return bundle;
  };
  const identity = async () => {
    const signal = activeSignal();
    const run = (file: string, args: string[]) =>
      getExecutor().runFileAsync(file, args, { timeoutMs: 30_000, signal, declareFor: context });
    const swift = await run('swift', ['--version']);
    const sdk = await run('xcrun', ['--sdk', 'macosx', '--show-sdk-build-version']);
    const xcode = await run('xcodebuild', ['-version']);
    return swiftpmArtifactSnapshot(
      root,
      declaration,
      build,
      { swift, sdk, xcode, arch: process.arch },
      context.env,
      signal,
    );
  };
  return {
    identity,
    async has(key) {
      const signal = activeSignal();
      if (!(await local.stat({ key: fileKey(key), signal }))) return false;
      const directory = await mkdtemp(join(tmpdir(), 'stim-macos-cache-plan-'));
      try {
        const source = await local.resolve({ key: fileKey(key), destinationDir: directory, signal });
        if (!source) return false;
        await unpack(source, key, directory);
        return true;
      } catch {
        signal.throwIfAborted();
        return false;
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    async restore(key, directory) {
      const signal = activeSignal();
      await mkdir(directory, { recursive: true });
      const cached = await local.resolve({ key: fileKey(key), destinationDir: directory, signal });
      if (cached) {
        try {
          return { bundle: await unpack(cached, key, directory), tier: 'local' };
        } catch {
          signal.throwIfAborted();
          await rm(join(directory, 'Cached.app'), { recursive: true, force: true });
        }
      }
      const files = await shared();
      if (!files) return null;
      const result = await providerCall(
        (childSignal) => files.resolve({ key: fileKey(key), destinationDir: directory, signal: childSignal }),
        buildResolveTimeoutMs(context.env),
        context,
        directory,
        signal,
      );
      signal.throwIfAborted();
      if (!result) return null;
      await contained(result, directory);
      const bundle = await unpack(result, key, directory);
      await storeLocal(key, result, signal);
      return { bundle, tier: 'provider' };
    },
    async store(key, bundle, directory) {
      const signal = activeSignal();
      const canonical = join(directory, 'Canonical.app');
      await cp(bundle, canonical, {
        recursive: true,
        verbatimSymlinks: true,
        filter: () => {
          signal.throwIfAborted();
          return true;
        },
      });
      await cp(resolve(root, build.infoPlist), join(canonical, 'Contents', 'Info.plist'));
      await reidentifyBundle(context, canonical, recipe.bundleId);
      await recipe.validateFetched(canonical, recipe.bundleId);
      const sourcePath = join(directory, 'artifact.cache');
      await packMacosArtifact(canonical, key, sourcePath, signal);
      if ((await identity()).key !== key) throw new Error('SwiftPM inputs changed while the cache entry was packed.');
      await storeLocal(key, sourcePath, signal);
      const files = await shared();
      if (!files) return;
      await providerCall(
        (childSignal) => files.store({ key: fileKey(key), sourcePath, overwrite: true, signal: childSignal }),
        buildUploadTimeoutMs(context.env),
        context,
        directory,
        signal,
      );
      signal.throwIfAborted();
    },
  };
}
