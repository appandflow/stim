import { ACTIVE_BUILD_KEY, parseActiveBuild } from '../engine/build-progress.ts';
import { requestNativeRunCancel } from '../engine/native-run.ts';
import * as results from '../commands/android/result.ts';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAndroidOperation } from '../commands/android/build.ts';
import { buildCacheKey, filesystemBuildCapability } from '../cache/build-cache.ts';
import { skippedMissReason } from '../cache/miss-reason.ts';
import { projectRegistry } from '../integrations/projects.ts';
import type { AndroidProject } from '../integrations/android-project.ts';
import { readBuildHistory } from '@stim-cli/core/state';
import { workspaceLogsDir } from '../workspace/paths.ts';
import { readWorkspaceState, writeWorkspaceState } from '../workspace/workspace-state.ts';

let scratch: string;
let root: string;
let compilations: number;
let failBuild: boolean;
let cancelCompile: boolean;
let cancelMaterialize: boolean;
let temporaryCopies: string[];

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'stim-android-build-'));
  root = join(scratch, 'project');
  mkdirSync(root);
  vi.stubEnv('STIM_HOME', join(scratch, 'state'));
  vi.stubEnv('STIM_BUILD_CACHE', join(scratch, 'cache'));
  writeFileSync(join(root, 'Main.kt'), 'initial source');
  compilations = 0;
  failBuild = false;
  cancelCompile = false;
  cancelMaterialize = false;
  temporaryCopies = [];
  const project: AndroidProject = {
    isExpo: false,
    packageRemedy: '',
    targets: [],
    eas: false,
    appIds: () => ({ bundleId: null, androidPackage: 'org.example.native' }),
    variantProblem: () => null,
    runtimeKind: () => 'process',
    runtime: () => {
      throw new Error('A build must not create a runtime.');
    },
    artifact({ buildPlan, target }) {
      const hash = createHash('sha256')
        .update(readFileSync(join(root, 'Main.kt')))
        .digest('hex');
      const identity = {
        hash,
        key: buildCacheKey('android', hash, {
          variant: buildPlan.variant ?? 'debug',
          ...(target.abi ? { abi: target.abi } : {}),
        }),
      };
      return {
        identity: async () => identity,
        cache: () => filesystemBuildCapability(),
        prepare: async () => {},
        reconcile: async () => ({ identity, rekeyedBy: [], cacheRefusal: null }),
        validate: async () => identity,
        materialize: async (_key, cached) => {
          const directory = mkdtempSync(join(scratch, 'materialized-'));
          temporaryCopies.push(directory);
          const apkPath = join(directory, 'app.apk');
          copyFileSync(cached, apkPath);
          if (cancelMaterialize) cancelActiveBuild();
          return { apkPath, directory };
        },
        compile: async () => {
          compilations++;
          if (cancelCompile) {
            cancelActiveBuild();
            return {
              ok: false,
              code: 'STIM_BUILD_FAILED',
              reason: 'Gradle was interrupted',
              diagnostics: [],
              truncated: 0,
              durationMs: 1,
              lastLines: [],
            };
          }
          if (failBuild) throw Object.assign(new Error('Compiler refused input'), { code: 'COMPILER_REFUSED' });
          const apkPath = join(root, 'build.apk');
          writeFileSync(
            apkPath,
            JSON.stringify({
              source: readFileSync(join(root, 'Main.kt'), 'utf8'),
              abi: target.abi,
              variant: buildPlan.variant,
            }),
          );
          return { ok: true, apkPath, apkNote: null, durationMs: 1, lastLines: [] };
        },
        explain: () => ({ reason: skippedMissReason('fixture has no cached build'), diff: null }),
        untrackedLine: () => null,
        legacyCache: null,
        offload: null,
      };
    },
  };
  vi.spyOn(projectRegistry, 'selectAndroid').mockReturnValue({ id: 'fixture', load: async () => project });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(scratch, { recursive: true, force: true });
});

test('build-only keeps artifacts after temporary cleanup, reuses compatible input and preserves an existing runtime', async () => {
  const cold = await buildAndroidOperation(root, { abi: 'x86_64', remoteBuild: 'local' });
  expect(cold).toMatchObject({ androidPackage: 'org.example.native', abi: 'x86_64', cacheHit: false });
  expect(readWorkspaceState(root)).not.toHaveProperty('android');
  expect(readWorkspaceState(root)).not.toHaveProperty('supervisor');
  const existing = { serial: 'already-running', devicePlacement: { machine: 'paired-mini' } };
  const running = { platform: 'android', status: 'ok', appPath: '/runtime/app.apk', cacheKey: 'runtime-key' };
  writeWorkspaceState(root, { android: existing, lastBuild: running, lastAndroidBuild: running });
  const runningLog = join(workspaceLogsDir(root), 'build-android.ndjson');
  writeFileSync(runningLog, '{"msg":"running app build"}\n');
  const bytes = readFileSync(cold.apkPath, 'utf8');
  const warm = await buildAndroidOperation(root, { abi: 'x86_64', remoteBuild: 'local' });
  expect(warm).toMatchObject({ cacheKey: cold.cacheKey, cacheHit: 'local' });
  expect(compilations).toBe(1);
  expect(readFileSync(warm.apkPath, 'utf8')).toBe(bytes);
  expect(temporaryCopies.length).toBeGreaterThan(0);
  expect(temporaryCopies.every((path) => !existsSync(path))).toBe(true);
  expect(readWorkspaceState(root)?.android).toEqual(existing);
  for (const options of [{ abi: 'arm64-v8a' as const }, { abi: 'x86_64' as const, variant: 'release' }]) {
    const changed = await buildAndroidOperation(root, { ...options, remoteBuild: 'local' });
    expect(changed.cacheHit).toBe(false);
    expect(changed.cacheKey).not.toBe(cold.cacheKey);
  }
  writeFileSync(join(root, 'Main.kt'), 'edited source');
  const edited = await buildAndroidOperation(root, { abi: 'x86_64', remoteBuild: 'local' });
  expect(edited.cacheKey).not.toBe(cold.cacheKey);
  expect(edited.cacheHit).toBe(false);
  expect(compilations).toBe(4);
  expect(readFileSync(cold.apkPath, 'utf8')).toBe(bytes);
  expect(readWorkspaceState(root)).toMatchObject({ android: existing, lastBuild: running, lastAndroidBuild: running });
  expect(readFileSync(runningLog, 'utf8')).toBe('{"msg":"running app build"}\n');
});

test('a failed compiler releases the build claim so recovery works without stopping the existing runtime', async () => {
  const existing = { serial: 'already-running', devicePlacement: { machine: 'paired-mini' } };
  writeWorkspaceState(root, { android: existing });
  failBuild = true;
  await expect(buildAndroidOperation(root, { remoteBuild: 'local' })).rejects.toMatchObject({
    code: 'COMPILER_REFUSED',
  });
  expect(readWorkspaceState(root)?.android).toEqual(existing);
  failBuild = false;
  const recovered = await buildAndroidOperation(root, { remoteBuild: 'local' });
  expect(existsSync(recovered.apkPath)).toBe(true);
  expect(readWorkspaceState(root)?.android).toEqual(existing);
  expect(compilations).toBe(2);
});

function cancelActiveBuild() {
  const active = parseActiveBuild(readWorkspaceState(root)?.[ACTIVE_BUILD_KEY]);
  if (!active) throw new Error('Expected an active claimed build');
  requestNativeRunCancel(root, active.claim.claimId);
  process.emit('SIGINT');
}

test.each(['compile', 'upload', 'materialize'])(
  'a whole-workspace cancellation during %s is reported as cancelled and allows recovery',
  async (during) => {
    const existing = { serial: 'already-running' };
    writeWorkspaceState(root, { android: existing });
    if (during === 'compile') cancelCompile = true;
    else if (during === 'materialize') {
      await buildAndroidOperation(root, { remoteBuild: 'local' });
      cancelMaterialize = true;
    } else
      vi.spyOn(results, 'finishAndroidUpload').mockImplementationOnce(async () => {
        cancelActiveBuild();
        return false;
      });
    await expect(buildAndroidOperation(root, { remoteBuild: 'local' })).rejects.toMatchObject({
      code: 'STIM_CANCELLED',
    });
    expect(readBuildHistory(readWorkspaceState(root)).android?.[0]).toMatchObject({
      result: 'cancelled',
      errorCode: 'STIM_CANCELLED',
    });
    expect(readWorkspaceState(root)?.android).toEqual(existing);
    expect(readWorkspaceState(root)?.[ACTIVE_BUILD_KEY]).toBeUndefined();
    expect(temporaryCopies.every((path) => !existsSync(path))).toBe(true);
    expect(temporaryCopies.length > 0).toBe(during === 'materialize');
    cancelCompile = false;
    cancelMaterialize = false;
    const recovered = await buildAndroidOperation(root, { remoteBuild: 'local' });
    expect(existsSync(recovered.apkPath)).toBe(true);
    expect(readWorkspaceState(root)?.android).toEqual(existing);
  },
);
