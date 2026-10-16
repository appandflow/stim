import assert from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createStim } from '../api.ts';
import { entryDir } from '../cache/build-cache.ts';
import { planCachedBuild } from '../commands/build-plan.ts';
import { DEFAULT_DEPS } from '../commands/ios/dependencies.ts';
import { resetExecutor, setExecutor } from '../exec.ts';
import { makeExecutor } from './_factories.ts';
import { testContext } from './_context.ts';
import { writeNativeXcodeProject } from './_native-xcode-project.ts';
import { withAmbientContext } from '@stim-cli/core';
import { runReport } from '../report-runtime.ts';

let scratch: string;
beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'stim-api-plan-')));
  vi.stubEnv('STIM_HOME', join(scratch, 'caller-home'));
});
afterEach(() => {
  resetExecutor();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(scratch, { recursive: true, force: true });
});

test('concurrent plan clients isolate cache homes without changing caller context or starting a runtime', async () => {
  const root = join(scratch, 'app');
  mkdirSync(root);
  writeNativeXcodeProject(root);
  const first = { home: join(scratch, 'first'), buildCache: join(scratch, 'first-cache') };
  const second = { home: join(scratch, 'second'), buildCache: join(scratch, 'second-cache') };
  setExecutor(
    makeExecutor({
      runFile: () => {
        throw new Error('Planning cannot run a synchronous probe.');
      },
      runFileAsync: async (file) => {
        if (file === 'git') throw new Error('Fixture is not a Git checkout.');
        return 'Fixture toolchain';
      },
      spawn: () => {
        throw new Error('Planning cannot start a runtime or build.');
      },
    }),
  );
  const env = { ...process.env };
  const cwd = process.cwd();
  const exit = process.exitCode;
  const signals = ['SIGINT', 'SIGTERM', 'exit'].map((name) => process.rawListeners(name));
  const log = vi.spyOn(console, 'log');
  const error = vi.spyOn(console, 'error');
  const firstClient = createStim({ projectRoot: root, ...first });
  const secondClient = createStim({ projectRoot: root, ...second });
  const [one, two] = await Promise.all([firstClient.plan({ platform: 'ios' }), secondClient.plan({ platform: 'ios' })]);
  assert(one.cacheKey);
  expect(one).toEqual(two);
  const artifact = join(entryDir('ios', one.cacheKey, first.buildCache), 'Fixture.app');
  mkdirSync(artifact, { recursive: true });
  writeFileSync(join(artifact, 'Fixture'), 'fixture artifact');
  const [hit, miss] = await Promise.all([
    firstClient.plan({ platform: 'ios' }),
    secondClient.plan({ platform: 'ios' }),
  ]);
  expect(hit.cacheHit).toBe('local');
  expect(miss.cacheHit).toBe(false);
  expect([first, second].map(({ home }) => existsSync(join(home, 'created-devices.json')))).toEqual([false, false]);
  expect(log).not.toHaveBeenCalled();
  expect(error).not.toHaveBeenCalled();
  expect(process.env).toEqual(env);
  expect(process.cwd()).toBe(cwd);
  expect(process.exitCode).toBe(exit);
  expect(['SIGINT', 'SIGTERM', 'exit'].map((name) => process.rawListeners(name))).toEqual(signals);
});

test.skipIf(process.platform !== 'darwin')(
  'a macOS plan validates the configured app without building or launching',
  async () => {
    const root = join(scratch, 'swift-app');
    mkdirSync(root);
    writeFileSync(join(root, 'Package.swift'), '// swift-tools-version: 6.0\n');
    writeFileSync(
      join(root, 'Info.plist'),
      '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.fixture.app</string><key>CFBundleExecutable</key><string>Example</string></dict></plist>',
    );
    writeFileSync(join(root, '.stim.json'), JSON.stringify({ macos: { product: 'Example', infoPlist: 'Info.plist' } }));
    setExecutor(
      makeExecutor({
        runFile: () => {
          throw new Error('Planning cannot run a synchronous probe.');
        },
        runFileAsync: async (file) => {
          expect(file).toBe('plutil');
          return JSON.stringify({ CFBundleIdentifier: 'dev.fixture.app', CFBundleExecutable: 'Example' });
        },
        spawn: () => {
          throw new Error('Planning cannot compile or launch.');
        },
      }),
    );
    const home = join(scratch, 'swift-home');
    expect(
      await createStim({ projectRoot: root, home, env: { ...process.env, STIM_REMOTE_BUILD: 'local' } }).plan({
        platform: 'macos',
      }),
    ).toMatchObject({
      platform: 'macos',
      product: 'Example',
      buildMachine: 'local',
      fingerprint: null,
      cacheHit: false,
      expectedMs: null,
    });
    expect(existsSync(join(root, '.build'))).toBe(false);
    expect(existsSync(join(home, 'created-devices.json'))).toBe(false);
  },
);

test.each(['caller', 'timeout'] as const)(
  'a %s cancellation drains a provider before removing its download directory',
  async (mode) => {
    vi.stubEnv('STIM_CACHE_BUILD_RESOLVE_TIMEOUT_MS', '60000');
    const root = join(scratch, 'app');
    mkdirSync(root);
    const controller = new AbortController();
    let downloading = '';
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let stopped!: () => void;
    const cancelled = new Promise<void>((resolve) => {
      stopped = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let settled = false;
    const lookup = planCachedBuild(
      {
        root,
        platform: 'ios',
        slot: 'default',
        projectKey: root,
        isExpo: false,
        fingerprint: 'identity',
        sources: [],
        cacheKey: 'pending-provider',
        cachePolicy: { read: true, remote: true },
        expoRemote: null,
        providerConfig: { provider: 'fixture', options: {}, baseDir: root },
      },
      {
        ...DEFAULT_DEPS,
        operation: testContext({
          home: join(scratch, 'home'),
          projectRoot: root,
          signal: controller.signal,
          env: { ...process.env, STIM_CACHE_BUILD_RESOLVE_TIMEOUT_MS: '20' },
        }),
        note: () => {},
        planPrebuild: () => 'none',
        loadCacheProvider: async () => ({
          name: 'fixture',
          provider: {
            builds: {
              store: () => null,
              resolve: async ({ destinationDir, signal }) => {
                downloading = destinationDir;
                signal.addEventListener('abort', stopped, { once: true });
                entered();
                await gate;
                writeFileSync(join(destinationDir, 'cleanup-proof'), 'last write before settling');
                return null;
              },
            },
          },
        }),
      },
    );
    const outcome = lookup
      .then(
        () => ({ ok: true }),
        () => ({ ok: false }),
      )
      .finally(() => {
        settled = true;
      });
    try {
      await ready;
      if (mode === 'caller') controller.abort();
      await cancelled;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      expect(existsSync(downloading)).toBe(true);
      release();
      expect(await outcome).toEqual({ ok: mode === 'timeout' });
      expect(existsSync(downloading)).toBe(false);
    } finally {
      release();
      await outcome;
    }
  },
);

test.each(['api', 'cli'] as const)('the %s plan keeps custom Expo plugins outside bounded reports', async (mode) => {
  const root = join(scratch, 'expo-app');
  mkdirSync(root);
  const evaluated = join(scratch, 'evaluated');
  const resolved = join(scratch, 'resolved');
  writeFileSync(join(root, 'package.json'), '{}');
  writeFileSync(join(root, 'app.json'), JSON.stringify({ expo: { buildCacheProvider: { plugin: './cache.cjs' } } }));
  writeFileSync(
    join(root, 'cache.cjs'),
    `
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(evaluated)}, 'loaded');
module.exports = {
  resolveBuildCache: async () => {
    fs.writeFileSync(${JSON.stringify(resolved)}, 'resolved');
    return null;
  },
  uploadBuildCache: async () => null,
};
`,
  );
  const context = testContext({ home: join(scratch, 'home'), projectRoot: root });
  const read = (operation = context) =>
    planCachedBuild(
      {
        root,
        platform: 'ios',
        slot: 'default',
        projectKey: root,
        isExpo: true,
        fingerprint: 'identity',
        sources: [],
        cacheKey: 'custom-expo',
        cachePolicy: { read: true, remote: false },
        providerConfig: null,
        expoRemote: { runOptions: null },
      },
      { ...DEFAULT_DEPS, operation, note: () => {}, planPrebuild: () => 'none' },
    );
  const plan =
    mode === 'api'
      ? await runReport(context, (operation) => withAmbientContext(operation, () => read(operation)))
      : await withAmbientContext(context, () => read());
  expect(plan.cacheHit).toBe(false);
  expect(existsSync(evaluated)).toBe(mode === 'cli');
  expect(existsSync(resolved)).toBe(mode === 'cli');
});
