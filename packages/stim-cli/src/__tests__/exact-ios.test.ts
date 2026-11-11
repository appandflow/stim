import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';

import { exactIosProject } from '../integrations/exact-ios.ts';
import type { IosArtifactContext } from '../integrations/ios-project.ts';
import { resolveOptimizations } from '../optimizations.ts';
import type { IosCommandOptions } from '../commands/ios/types.ts';
import { resolveSettings } from '../workspace/settings.ts';
import { testContext } from './_context.ts';

let root: string;
let home: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stim-exact-'));
  home = mkdtempSync(join(tmpdir(), 'stim-exact-home-'));
  process.env.STIM_HOME = home;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  delete process.env.STIM_HOME;
});

function exactScript(body: string): void {
  const path = join(root, 'exact.mjs');
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

function context(
  configuration: string | null,
  booted: IosArtifactContext['target']['booted'] | null = async () => ({ ok: true, udid: 'SIM-1' }),
): IosArtifactContext {
  return {
    root,
    logFile: join(root, 'build.log'),
    configuration,
    target: {
      udid: null,
      destination: null,
      sdk: 'iphonesimulator',
      arch: null,
      keyArch: null,
      offloadRuntime: () => null,
      offloadRefusal: null,
      ...(booted ? { booted } : {}),
    },
    device: null,
    optimizations: resolveOptimizations({}, {}).ios,
    cache: { read: false, write: false, remote: false },
    phase: () => {},
    note: () => {},
    logWriter: () => ({
      file: join(root, 'build.ndjson'),
      write: () => true,
      close: () => ({ file: join(root, 'build.ndjson'), written: 0, dropped: 0, lastError: null }),
      written: 0,
      dropped: 0,
      lastError: null,
    }),
    estimates: () => ({ coldBuildMs: null, podsMs: null }),
    step: () => {},
    setPodsMs: () => {},
  };
}

const compile = (ctx: IosArtifactContext) => exactIosProject(root).artifact(ctx).compile();

test.skipIf(process.platform !== 'darwin')(
  'installs the app Exact reports, building on the booted simulator',
  async () => {
    const app = join(root, 'target', 'Shop.app');
    mkdirSync(app, { recursive: true });
    writeFileSync(
      join(app, 'Info.plist'),
      '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.example.shop</string></dict></plist>',
    );
    exactScript(
      [
        'echo "Compiling exact-kernel v0.1.0"',
        `echo "host/apple: ${app} (cargo 3.8 s); built and signed, installed on nothing (--no-install) $EXACT_SIM $*"`,
        'echo "host/apple: no Metal toolchain, so no Canvas 2D GPU module"',
      ].join('\n'),
    );

    const result = await compile(context('Release'));

    expect(result).toMatchObject({ ok: true, appPath: app, bundleId: 'com.example.shop' });
  },
);

test.skipIf(process.platform === 'win32').each([
  ['Debug', 'SIM-1 ios --no-install'],
  ['Release', 'SIM-1 ios --no-install --release'],
])(
  'runs a %s build on the booted simulator and reports its last line when Exact prints no error',
  async (configuration, line) => {
    exactScript('echo "warning: a Contract lint"\necho "$EXACT_SIM $*"\nexit 1');

    const result = await compile(context(configuration));

    expect(result).toMatchObject({ ok: false, exitCode: 1, diagnostics: [{ message: line }] });
  },
);

test.skipIf(process.platform === 'win32')('reports error lines and a run that built no app', async () => {
  exactScript('echo "error: Cargo has no shop-apple target"\nexit 2');
  expect(await compile(context(null))).toMatchObject({
    ok: false,
    diagnostics: [{ message: 'error: Cargo has no shop-apple target' }],
  });

  exactScript('echo "done"');
  expect(await compile(context(null))).toMatchObject({
    ok: false,
    diagnostics: [{ message: './exact.mjs ios reported no built app with a bundle id' }],
  });
});

test.each([
  [{ app: { id: 'com.example.shop' } }, 'com.example.shop'],
  [{ app: { id: '' } }, null],
  [{ app: 'com.example.shop' }, null],
])('takes the bundle id from app.json app.id before any build: %j', async (manifest, id) => {
  writeFileSync(join(root, 'app.json'), JSON.stringify(manifest));

  expect(await exactIosProject(root).bundleId()).toBe(id);
});

test('reports an exact.mjs that cannot run', async () => {
  const result = await compile(context(null));

  expect(result).toMatchObject({
    ok: false,
    diagnostics: [{ message: expect.stringMatching(/^could not run \.\/exact\.mjs: /) }],
  });
});

test.skipIf(process.platform === 'win32')(
  'builds without a simulator unless app.json declares native modules',
  async () => {
    exactScript('echo "sim=$EXACT_SIM $*" > ran.txt\nexit 1');
    writeFileSync(join(root, 'app.json'), JSON.stringify({ app: { id: 'com.example.shop' }, modules: [] }));

    expect(await compile(context(null, null))).toMatchObject({ ok: false, exitCode: 1 });
    expect(readFileSync(join(root, 'ran.txt'), 'utf8')).toBe('sim= ios --no-install\n');

    writeFileSync(join(root, 'app.json'), JSON.stringify({ app: { id: 'com.example.shop' }, modules: ['shop-map'] }));
    await expect(compile(context(null, null))).rejects.toMatchObject({ failure: { code: 'STIM_BAD_ARG' } });
  },
);

test('refuses when the workspace simulator does not boot', async () => {
  exactScript('exit 0');

  await expect(compile(context(null, async () => ({ ok: false, reason: 'boot timed out' })))).rejects.toMatchObject({
    failure: { code: 'STIM_NO_DEVICE', message: 'boot timed out' },
  });
});

test.skipIf(process.platform === 'win32')('waits for the boot before build admission, and boots once', async () => {
  exactScript('[ "$EXACT_SIM" = SIM-2 ] && exit 7\nexit 1');
  let finish: (udid: string) => void = () => {};
  let calls = 0;
  const recipe = exactIosProject(root).artifact(
    context(null, () => {
      calls += 1;
      return new Promise((resolve) => (finish = (udid) => resolve({ ok: true, udid })));
    }),
  );

  let identified = false;
  const identity = recipe.identity().then(() => (identified = true));
  await new Promise(setImmediate);
  expect(identified).toBe(false);
  finish('SIM-2');
  await identity;

  expect(await recipe.compile()).toMatchObject({ ok: false, exitCode: 7 });
  expect(calls).toBe(1);
});

test("an Exact build is incremental when target/ already holds the simulator's Rust output for its configuration", async () => {
  const incremental = async (configuration: string | null) => {
    const identity = await exactIosProject(root).artifact(context(configuration)).identity();
    return 'incremental' in identity ? identity.incremental : undefined;
  };
  const triple = process.arch === 'arm64' ? 'aarch64-apple-ios-sim' : 'x86_64-apple-ios';
  mkdirSync(join(root, 'target', 'wasm32-unknown-unknown', 'host-dev'), { recursive: true });
  expect(await incremental(null)).toBe(false);

  mkdirSync(join(root, 'target', triple, 'host-dev'), { recursive: true });
  expect(await incremental('Debug')).toBe(true);
  expect(await incremental('Release')).toBe(false);
});

function plan(options: IosCommandOptions) {
  const settingsContext = { projectPath: root, gitCommonDir: null, repoRoot: null };
  const planner = exactIosProject(root).plan;
  if (!planner) throw new Error('The Exact integration has no plan.');
  return planner(options, { context: settingsContext, settings: resolveSettings(settingsContext) }, testContext());
}

test('plans an uncached build on this machine with the bundle id from app.json', async () => {
  writeFileSync(join(root, 'app.json'), JSON.stringify({ app: { id: 'com.example.shop' } }));
  expect(await plan({ remoteBuild: 'local', remote: 'auto' })).toEqual({
    platform: 'ios',
    fingerprint: null,
    cacheKey: null,
    cacheHit: false,
    provider: null,
    cacheSkipped: false,
    prebuild: null,
    outcome: 'cold',
    expectedMs: null,
    basis: 0,
    missReason: expect.objectContaining({
      kind: 'cache-skipped',
      summary: 'Exact builds incrementally in its own target/ directory',
    }),
    placement: 'this machine',
    bundleId: 'com.example.shop',
  });
});

test('refuses to plan the EAS device the run refuses', async () => {
  expect(await plan({ remote: 'eas' })).toEqual({
    refusal: expect.objectContaining({
      code: 'STIM_BAD_ARG',
      message: 'This project integration does not support the remote iOS target.',
    }),
  });
});

test('an app that declares native modules keeps an automatic placement here and refuses a hosted one', async () => {
  writeFileSync(join(root, 'app.json'), JSON.stringify({ app: { id: 'com.example.shop' }, modules: ['camera'] }));
  expect(exactIosProject(root).targets).not.toContain('hosted');
  expect(await plan({ remoteBuild: 'local', remote: 'auto' })).toMatchObject({
    placement: expect.stringMatching(/^this machine; an Exact app that declares native modules/),
  });
  for (const remote of ['janics-mac-mini', 'remote-only'])
    expect(await plan({ remoteBuild: 'local', remote })).toEqual({
      refusal: expect.objectContaining({
        code: 'STIM_BAD_ARG',
        message: expect.stringMatching(/^This app cannot run on a hosted iOS simulator: /),
      }),
    });
});

test('names why an Exact build that cannot offload stays here, and refuses a named build machine', async () => {
  writeFileSync(join(root, 'app.json'), JSON.stringify({ app: { id: 'com.example.shop' }, modules: ['camera'] }));
  expect(await plan({ remoteBuild: 'auto' })).toMatchObject({
    buildPlacement: { preference: 'auto', reason: 'builds on this machine: no remote machine is paired' },
  });
  expect(await plan({ remoteBuild: 'mini' })).toMatchObject({
    outcome: null,
    refusal: {
      code: 'STIM_OFFLOAD_REFUSED',
      message: expect.stringContaining('Exact apps that declare native modules build here'),
    },
  });
});

test('refuses a scheme or an Xcode configuration Exact does not have', async () => {
  expect(await plan({ scheme: 'App' })).toMatchObject({ refusal: { code: 'STIM_BAD_ARG' } });
  expect(await plan({ configuration: 'Staging' })).toMatchObject({ refusal: { code: 'STIM_BAD_ARG' } });
});

test('estimates from earlier incremental runs once target/ holds the simulator build', async () => {
  const sample = (durationMs: number, incremental: boolean) => ({ at: 1, durationMs, phases: {}, incremental });
  writeFileSync(
    join(home, 'stats.json'),
    JSON.stringify({
      version: 1,
      history: { [realpathSync(root)]: { ios: { cold: [sample(300_000, false), sample(30_000, true)] } } },
    }),
  );
  expect(await plan({ remoteBuild: 'local' })).toMatchObject({ expectedMs: 300_000, basis: 1 });
  const triple = process.arch === 'arm64' ? 'aarch64-apple-ios-sim' : 'x86_64-apple-ios';
  mkdirSync(join(root, 'target', triple, 'host-dev'), { recursive: true });
  expect(await plan({ remoteBuild: 'local' })).toMatchObject({ expectedMs: 30_000, basis: 1 });
});
