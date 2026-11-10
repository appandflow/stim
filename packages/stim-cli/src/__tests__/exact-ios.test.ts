import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';

import { exactIosProject } from '../integrations/exact-ios.ts';
import { IosRecipeRefusal, type IosArtifactContext } from '../integrations/ios-project.ts';
import { resolveOptimizations } from '../optimizations.ts';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stim-exact-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
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

test('refuses without a booted workspace simulator', async () => {
  exactScript('exit 0');

  await expect(compile(context(null, null))).rejects.toBeInstanceOf(IosRecipeRefusal);
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
