import * as artifacts from '../commands/ios/artifact.ts';
import { readBuildHistory } from '@stim-cli/core/state';
import { testContext } from './_context.ts';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  promises as fs,
  readFileSync,
  symlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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

import { workspaceDir } from '../workspace/paths.ts';
import { readWorkspaceState, writeWorkspaceState } from '../workspace/workspace-state.ts';

let controller = new AbortController();
const buildContext = () => testContext({ signal: controller.signal });

let scratch: string;
let root: string;
let compilations: number;
let failBuild: boolean;
let cancelBuild: boolean;
let copies: string[];
let projectBundleId: string | null;
let linkedApp: boolean;

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
  linkedApp = false;
  const runFile = getExecutor().runFileAsync;
  vi.spyOn(getExecutor(), 'runFileAsync').mockImplementation(async (command, args, options) => {
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
          cpSync(path, app, { recursive: true, verbatimSymlinks: true });
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
            const cancelled = controller;
            controller = new AbortController();
            cancelled.abort('SIGINT');
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
          const alias = join(appPath, 'Alias');
          if (linkedApp && !existsSync(alias)) symlinkSync('Native', alias);
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
        expoCache: null,
        offload: null,
      };
    },
  };
  vi.spyOn(projectRegistry, 'selectIos').mockReturnValue({ id: 'fixture', load: async () => project });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(scratch, { recursive: true, force: true });
});

test.each(['failure', 'cancellation'])(
  'build %s releases its claim and permits recovery without stopping an existing simulator',
  async (mode) => {
    const existing = { udid: 'existing' };
    writeWorkspaceState(root, { ios: existing });
    failBuild = mode === 'failure';
    cancelBuild = mode === 'cancellation';
    await expect(buildIosOperation(buildContext(), root, { remoteBuild: 'local' })).rejects.toMatchObject({
      code: cancelBuild ? 'STIM_CANCELLED' : 'COMPILER_FAILED',
    });
    expect(readWorkspaceState(root)?.ios).toEqual(existing);
    expect(parseActiveBuild(readWorkspaceState(root)?.[ACTIVE_BUILD_KEY])).toBeNull();
    failBuild = cancelBuild = false;
    const recovered = await buildIosOperation(buildContext(), root, { remoteBuild: 'local' });
    expect(existsSync(recovered.appPath)).toBe(true);
    expect(readWorkspaceState(root)?.ios).toEqual(existing);
  },
);

test('cancelling an app export drains the copy before cleanup and permits recovery', async () => {
  const existing = { udid: 'existing' };
  writeWorkspaceState(root, { ios: existing });
  const copy = fs.cp;
  let began!: (value: boolean) => void;
  const copying = new Promise<boolean>((resolve) => {
    began = resolve;
  });
  let finish!: () => void;
  const completion = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let destination = '';
  vi.spyOn(fs, 'cp').mockImplementationOnce(async (...args) => {
    destination = String(args[1]);
    await copy(...args);
    began(true);
    await completion;
  });
  const operation = buildIosOperation(buildContext(), root, { remoteBuild: 'local' });
  let settled = false;
  void operation.then(
    () => {
      return (settled = true);
    },
    () => {
      return (settled = true);
    },
  );
  try {
    expect(await Promise.race([copying, operation.then(() => false)])).toBe(true);
    controller.abort('SIGINT');
    await vi.advanceTimersByTimeAsync(10);
    expect(settled).toBe(false);
    expect(existsSync(join(destination, 'Native'))).toBe(true);
  } finally {
    finish();
  }
  await expect(operation).rejects.toMatchObject({ code: 'STIM_CANCELLED' });
  expect(await fs.readdir(join(workspaceDir(root), 'artifacts'))).toEqual([]);
  expect(parseActiveBuild(readWorkspaceState(root)?.[ACTIVE_BUILD_KEY])).toBeNull();
  expect(readWorkspaceState(root)?.ios).toEqual(existing);
  controller = new AbortController();
  const recovered = await buildIosOperation(buildContext(), root, { remoteBuild: 'local' });
  expect(existsSync(join(recovered.appPath, 'Native'))).toBe(true);
});

test('cancellation after exporting the app still refuses the result and removes the export', async () => {
  const acquire = artifacts.acquireIosArtifact;
  vi.spyOn(artifacts, 'acquireIosArtifact').mockImplementationOnce(async (...args) => {
    const result = await acquire(...args);
    if (result.ok) {
      const release = result.artifact.release.bind(result.artifact);
      result.artifact.release = async () => {
        controller.abort('SIGINT');
        await release();
      };
    }
    return result;
  });
  await expect(buildIosOperation(buildContext(), root, { remoteBuild: 'local' })).rejects.toMatchObject({
    code: 'STIM_CANCELLED',
  });
  expect(await fs.readdir(join(workspaceDir(root), 'artifacts'))).toEqual([]);
  expect(readBuildHistory(readWorkspaceState(root)).ios).toEqual([
    expect.objectContaining({ result: 'cancelled', errorCode: 'STIM_CANCELLED' }),
  ]);
});
