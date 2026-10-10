import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildIosOperation } from '../commands/ios/build.ts';
import { buildCacheKey, filesystemBuildCapability } from '../cache/build-cache.ts';
import { skippedMissReason } from '../cache/miss-reason.ts';
import { ACTIVE_BUILD_KEY, parseActiveBuild } from '../engine/build-progress.ts';
import { requestNativeRunCancel } from '../engine/native-run.ts';
import { COMPILATION_CACHE_NOT_RUN } from '../engine/xcode.ts';
import { getExecutor } from '../exec.ts';
import type { IosProject } from '../integrations/ios-project.ts';
import { projectRegistry } from '../integrations/projects.ts';
import { SETTING_SHAPE_REMEDY } from '../workspace/settings.ts';
import { readWorkspaceState, writeWorkspaceState } from '../workspace/workspace-state.ts';

let scratch: string;
let root: string;
let compilations: number;
let failBuild: boolean;
let cancelBuild: boolean;
let copies: string[];
let projectBundleId: string | null;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'stim-ios-build-'));
  root = join(scratch, 'project');
  mkdirSync(root);
  vi.stubEnv('STIM_HOME', join(scratch, 'state'));
  vi.stubEnv('STIM_BUILD_CACHE', join(scratch, 'cache'));
  writeFileSync(join(root, 'Main.swift'), 'original');
  writeFileSync(join(root, '.stim.json'), JSON.stringify({ optimizations: { releaseBundleSwap: false } }));
  compilations = 0;
  failBuild = false;
  cancelBuild = false;
  copies = [];
  projectBundleId = 'org.example.native';
  const runFile = getExecutor().runFile;
  vi.spyOn(getExecutor(), 'runFile').mockImplementation((command, args, options) => {
    if (command === 'plutil') {
      const plist = readFileSync(String(args?.at(-1)), 'utf8');
      return JSON.stringify({ CFBundleIdentifier: plist.match(/<string>([^<]+)<\/string>/)?.[1] });
    }
    return runFile(command, args, options);
  });
  const project: IosProject = {
    isExpo: false,
    targets: [],
    eas: false,
    bundleId: () => projectBundleId,
    schemeProblem: () => null,
    runtimeKind: () => 'process',
    runtime: () => {
      throw new Error('Build-only must not create a runtime.');
    },
    artifact({ configuration, target }) {
      const hash = createHash('sha256')
        .update(readFileSync(join(root, 'Main.swift')))
        .digest('hex');
      const identity = {
        hash,
        key: buildCacheKey('ios', hash, {
          configuration: configuration ?? 'Debug',
          isSimulator: true,
          ...(target.keyArch ? { arch: target.keyArch } : {}),
        }),
      };
      return {
        identity: async () => identity,
        cache: () => filesystemBuildCapability(),
        prepare: async () => {},
        reconcile: async () => ({ identity, rekeyedBy: [], mutationLabel: '' }),
        validate: async () => identity,
        validateExternal: () => {},
        materialize: async (path, { ownTemporary }) => {
          const directory = mkdtempSync(join(scratch, 'materialized-'));
          copies.push(directory);
          ownTemporary(directory);
          const app = join(directory, 'Native.app');
          cpSync(path, app, { recursive: true });
          return app;
        },
        compile: async () => {
          compilations++;
          expect(target.udid).toBeNull();
          expect(target.destination).toBe('generic/platform=iOS Simulator');
          if (cancelBuild) {
            const active = parseActiveBuild(readWorkspaceState(root)?.[ACTIVE_BUILD_KEY]);
            if (!active) throw new Error('Expected an active build claim');
            requestNativeRunCancel(root, active.claim.claimId);
            process.emit('SIGINT');
          }
          if (cancelBuild || failBuild)
            throw Object.assign(new Error('Compiler interrupted'), { code: 'COMPILER_FAILED' });
          const appPath = join(root, 'Native.app');
          mkdirSync(appPath, { recursive: true });
          writeFileSync(
            join(appPath, 'Info.plist'),
            '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>org.example.native</string></dict></plist>',
          );
          writeFileSync(
            join(appPath, 'Native'),
            `${readFileSync(join(root, 'Main.swift'), 'utf8')}:${configuration}:${target.arch}`,
          );
          return {
            ok: true,
            appPath,
            bundleId: 'org.example.native',
            scheme: 'Native',
            project: {
              dir: root,
              path: join(root, 'Native.xcodeproj'),
              kind: 'project',
              flag: '-project',
              name: 'Native',
            },
            derivedDataPath: root,
            productsDir: root,
            durationMs: 1,
            transcriptLines: 1,
            compilationCache: COMPILATION_CACHE_NOT_RUN,
          };
        },
        explain: () => ({ reason: skippedMissReason('No matching native app'), diff: null }),
        untrackedLine: () => null,
        legacyCache: null,
        offload: null,
      };
    },
  };
  vi.spyOn(projectRegistry, 'selectIos').mockReturnValue({ load: async () => project });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(scratch, { recursive: true, force: true });
});

test('native Release builds retain independent artifacts and cache without JS-swap or runtime setup', async () => {
  const options = { configuration: 'Release', arch: 'arm64', remoteBuild: 'local' } as const;
  const cold = await buildIosOperation(root, options);
  const bytes = readFileSync(join(cold.appPath, 'Native'), 'utf8');
  expect(cold.cacheHit).toBe(false);
  expect(readWorkspaceState(root)).not.toHaveProperty('ios');
  expect(readWorkspaceState(root)).not.toHaveProperty('supervisor');
  const existing = { udid: 'existing', devicePlacement: { machine: 'mini' } };
  writeWorkspaceState(root, { ios: existing });
  projectBundleId = null;
  const warm = await buildIosOperation(root, options);
  expect(warm).toMatchObject({ bundleId: 'org.example.native', cacheKey: cold.cacheKey, cacheHit: 'local' });
  expect(readWorkspaceState(root)?.lastIosBuild).toMatchObject({ bundleId: 'org.example.native' });
  expect(compilations).toBe(1);
  expect(readFileSync(join(warm.appPath, 'Native'), 'utf8')).toBe(bytes);
  expect(copies.length).toBeGreaterThan(0);
  expect(copies.every((path) => !existsSync(path))).toBe(true);
  expect(readWorkspaceState(root)?.ios).toEqual(existing);
  const differentArch = await buildIosOperation(root, { ...options, arch: 'x86_64' });
  expect(differentArch.cacheKey).not.toBe(cold.cacheKey);
  expect(differentArch.cacheHit).toBe(false);
  writeFileSync(join(root, 'Main.swift'), 'edited');
  const edited = await buildIosOperation(root, options);
  expect(edited.cacheKey).not.toBe(cold.cacheKey);
  expect(readFileSync(join(cold.appPath, 'Native'), 'utf8')).toBe(bytes);
  expect(readWorkspaceState(root)?.ios).toEqual(existing);
});

test.each(['failure', 'cancellation'])(
  'build %s releases its claim and permits recovery without stopping an existing simulator',
  async (mode) => {
    const existing = { udid: 'existing' };
    writeWorkspaceState(root, { ios: existing });
    failBuild = mode === 'failure';
    cancelBuild = mode === 'cancellation';
    await expect(buildIosOperation(root, { remoteBuild: 'local' })).rejects.toMatchObject({
      code: cancelBuild ? 'STIM_CANCELLED' : 'COMPILER_FAILED',
    });
    expect(readWorkspaceState(root)?.ios).toEqual(existing);
    expect(parseActiveBuild(readWorkspaceState(root)?.[ACTIVE_BUILD_KEY])).toBeNull();
    failBuild = cancelBuild = false;
    const recovered = await buildIosOperation(root, { remoteBuild: 'local' });
    expect(existsSync(recovered.appPath)).toBe(true);
    expect(readWorkspaceState(root)?.ios).toEqual(existing);
  },
);

test('an unusable optimizations setting is refused as a setting error before the build', async () => {
  writeFileSync(join(root, '.stim.json'), JSON.stringify({ optimizations: { buildCache: 'yes' } }));
  await expect(buildIosOperation(root, { remoteBuild: 'local' })).rejects.toMatchObject({
    code: 'STIM_BAD_ARG',
    remedy: SETTING_SHAPE_REMEDY,
  });
  expect(compilations).toBe(0);
});
