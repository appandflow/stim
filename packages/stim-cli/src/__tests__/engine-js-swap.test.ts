import type { ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  JS_BUNDLE_NAME,
  assetCatalogTarget,
  bundleCommand,
  detectEntryFile,
  hermesEnabledFromProperties,
  hermescArgs,
  hermescPath,
  pickEntryFile,
  readHermesEnabled,
  swapJsBundle,
} from '../engine/js-swap.ts';
import { getExecutor } from '../exec.ts';
import { makeChildProcess, makeExecutor, makeWriter } from './_factories.ts';

describe('hermescPath', () => {
  const root = '/proj';
  const modern = join('/proj/node_modules/hermes-compiler/hermesc/osx-bin/hermesc');
  const pods = join('/proj/ios/Pods/hermes-engine/destroot/bin/hermesc');
  const legacy = join('/proj/node_modules/react-native/sdks/hermesc/osx-bin/hermesc');

  test('prefers the hermes-compiler package (RN 0.8x), then Pods, then the legacy sdks path', () => {
    expect(hermescPath(root, { exists: (p) => p === modern || p === legacy })).toBe(modern);
    expect(hermescPath(root, { exists: (p) => p === pods })).toBe(pods);
    expect(hermescPath(root, { exists: (p) => p === legacy })).toBe(legacy);
  });

  test('nothing found answers the legacy path, whose absence the caller already guards', () => {
    expect(hermescPath(root, { exists: () => false })).toBe(legacy);
  });
});

describe('hermesEnabledFromProperties', () => {
  test('default is enabled: no file, no key, unparseable JSON', () => {
    expect(hermesEnabledFromProperties(null)).toBe(true);
    expect(hermesEnabledFromProperties('{}')).toBe(true);
    expect(hermesEnabledFromProperties('not json at all')).toBe(true);
    expect(hermesEnabledFromProperties('[]')).toBe(true);
  });

  test('only the string "false" (or a hand-edited boolean false) disables it', () => {
    expect(hermesEnabledFromProperties('{"hermesEnabled":"false"}')).toBe(false);
    expect(hermesEnabledFromProperties('{"hermesEnabled":false}')).toBe(false);
    expect(hermesEnabledFromProperties('{"hermesEnabled":"true"}')).toBe(true);
    expect(hermesEnabledFromProperties('{"hermesEnabled":"FALSE"}')).toBe(true);
  });

  test('readHermesEnabled defaults to enabled when ios/Podfile.properties.json is absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'stim-swap-'));
    try {
      expect(readHermesEnabled(root)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('pickEntryFile', () => {
  test('prefers index.js, then the TS variants, in the CLI resolution order', () => {
    expect(pickEntryFile(['App.tsx', 'index.js', 'index.ts'])).toBe('index.js');
    expect(pickEntryFile(['index.tsx', 'index.ts'])).toBe('index.ts');
    expect(pickEntryFile(['index.tsx'])).toBe('index.tsx');
  });

  test('falls back to index.js when nothing matches (bundle would default to it anyway)', () => {
    expect(pickEntryFile([])).toBe('index.js');
    expect(pickEntryFile(['App.js'])).toBe('index.js');
    expect(pickEntryFile(null)).toBe('index.js');
  });

  test('detectEntryFile survives an unreadable root', () => {
    expect(detectEntryFile('/nope/never/here')).toBe('index.js');
  });
});

describe('bundleCommand', () => {
  test("expo: the project's own `expo export:embed`, fixed argv, --dev false", () => {
    expect(
      bundleCommand({ isExpo: true, entryFile: 'index.js', bundleOutput: '/t/main.jsbundle', assetsDest: '/t/assets' }),
    ).toEqual({
      file: 'npx',
      args: [
        'expo',
        'export:embed',
        '--platform',
        'ios',
        '--dev',
        'false',
        '--bundle-output',
        '/t/main.jsbundle',
        '--assets-dest',
        '/t/assets',
      ],
    });
  });

  test("bare: the project's own `react-native bundle` with the detected entry file", () => {
    expect(
      bundleCommand({
        isExpo: false,
        entryFile: 'index.ts',
        bundleOutput: '/t/main.jsbundle',
        assetsDest: '/t/assets',
      }),
    ).toEqual({
      file: 'npx',
      args: [
        'react-native',
        'bundle',
        '--platform',
        'ios',
        '--dev',
        'false',
        '--entry-file',
        'index.ts',
        '--bundle-output',
        '/t/main.jsbundle',
        '--assets-dest',
        '/t/assets',
      ],
    });
  });
});

describe('hermesc', () => {
  test("the compiler is the PROJECT's own, and the argv is -emit-binary -out", () => {
    expect(hermescPath('/w/app')).toBe(join('/w/app/node_modules/react-native/sdks/hermesc/osx-bin/hermesc'));
    expect(hermescArgs({ bundle: '/t/main.jsbundle', out: '/t/main.jsbundle.hbc' })).toEqual([
      '-emit-binary',
      '-out',
      '/t/main.jsbundle.hbc',
      '/t/main.jsbundle',
    ]);
  });
});

let root: string;
let tmp: string;
const cachedApp = '/cache/ios/k-release-sim/Fixture.app';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stim-swap-root-'));
  tmp = mkdtempSync(join(tmpdir(), 'stim-swap-tmp-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });
});

function makeBundleChild(code = 0): ChildProcess {
  const child = makeChildProcess();
  setImmediate(() => {
    child.stdout?.emit('data', 'Writing bundle output...\n');
    child.emit('exit', code, null);
  });
  return child;
}

interface Call {
  op: string;
  file?: string;
  args?: string[];
}

function harness({
  bundleExit = 0,
  failOn = null as string | null,
  hermescExists = true,
  bundleWritten = true,
  infoPlist = {} as Record<string, unknown>,
  onBundle = () => {},
  onActool = (_out: string) => {},
} = {}) {
  const calls: Call[] = [];
  const appCopy = join(tmp, 'Fixture.app');
  const bundleOutput = join(tmp, JS_BUNDLE_NAME);
  const exec = makeExecutor({
    runFile: (file, args = []) => {
      calls.push({ op: 'runFile', file, args });
      if (failOn && (file === failOn || args[0] === failOn)) throw new Error(`${failOn} blew up`);
      if (file === 'plutil') {
        const [, key, format] = args;
        const value = infoPlist[key!];
        if (value === undefined) throw new Error(`Command failed: plutil\nNo value at that key path: ${key}`);
        return format === 'json' ? JSON.stringify(value) : String(value);
      }
      if (file === 'xcrun' && args[0] === 'actool') onActool(args[args.indexOf('--compile') + 1]!);
      return '';
    },
  });
  const spawnFn = (cmd: string, args: string[], _opts: Record<string, unknown>) => {
    calls.push({ op: 'spawn', file: cmd, args });
    onBundle();
    return makeBundleChild(bundleExit);
  };
  const exists = (p: string) => {
    if (p === hermescPath(root)) return hermescExists;
    if (p === bundleOutput) return bundleWritten;
    return existsSync(p);
  };
  const writer = makeWriter();
  const run = (overrides: Record<string, unknown> = {}) =>
    swapJsBundle({
      root,
      isExpo: true,
      cachedAppPath: cachedApp,
      logWriter: writer,
      exec,
      spawnFn,
      mkdtemp: () => tmp,
      exists,
      heartbeatMs: 0,
      ...overrides,
    });
  return { calls, run, appCopy, bundleOutput, writer };
}

describe('swapJsBundle', () => {
  test('the order IS the product: copy aside, bundle, hermesc, replace, re-sign -- and the cache entry is never written', async () => {
    const { calls, run, appCopy, bundleOutput } = harness();
    const result = await run();
    expect(result.ok).toBe(true);
    expect(result.appPath).toBe(appCopy);
    expect(result.tmpDir).toBe(tmp);
    expect(result.hermes).toBe(true);

    const shape = calls.map((c) => c.file);
    expect(shape).toEqual(['cp', 'plutil', 'npx', hermescPath(root), 'mv', 'cp', 'cp', 'codesign']);

    const copyAside = calls[0];
    expect(copyAside?.args).toEqual(['-c', '-R', cachedApp, appCopy]);
    const bundle = calls[2];
    expect(bundle?.args?.slice(0, 2)).toEqual(['expo', 'export:embed']);
    expect(bundle?.args).toContain(bundleOutput);
    const codesign = calls.at(-1);
    expect(codesign?.args).toEqual(['--force', '--sign', '-', appCopy]);
    for (const call of calls.slice(1)) {
      expect(call.args ?? []).not.toContain(cachedApp);
    }
  });

  test('bare project: the bundle step is `react-native bundle` with the detected entry file', async () => {
    const { calls, run } = harness();
    const result = await run({ isExpo: false });
    expect(result.ok).toBe(true);
    const bundle = calls.find((c) => c.op === 'spawn');
    expect(bundle?.args?.slice(0, 2)).toEqual(['react-native', 'bundle']);
    expect(bundle?.args).toContain('--entry-file');
  });

  test('hermes off (Podfile.properties.json says "false") skips hermesc entirely', async () => {
    const { calls, run } = harness();
    const result = await run({ hermesEnabled: false });
    expect(result.ok).toBe(true);
    expect(result.hermes).toBe(false);
    expect(calls.some((c) => c.file === hermescPath(root))).toBe(false);
  });

  test('hermesc missing is the GUARD, not a failure: plain JS bundle plus a note', async () => {
    const { calls, run } = harness({ hermescExists: false });
    const result = await run();
    expect(result.ok).toBe(true);
    expect(result.hermes).toBe(false);
    expect(result.note).toMatch(/hermesc not found/);
    expect(calls.some((c) => c.file === hermescPath(root))).toBe(false);
    expect(calls.at(-1)?.file).toBe('codesign');
  });

  test('a failed bundle command is a return value naming the step, and nothing downstream runs', async () => {
    const { calls, run } = harness({ bundleExit: 1 });
    const result = await run();
    expect(result.failed).toBe(true);
    expect(result.step).toBe('bundle');
    expect(result.lastLines).toEqual(['Writing bundle output...']);
    expect(existsSync(tmp)).toBe(false);
    expect(calls.some((c) => c.file === 'codesign')).toBe(false);
  });

  test.skipIf(process.platform === 'win32')(
    'failed swaps remove copied read-only app directories and preserve the full-build fallback (POSIX permission bits; skipped on win32)',
    async () => {
      const source = mkdtempSync(join(tmpdir(), 'stim-readonly-app-'));
      const app = join(source, 'Fixture.app');
      const resources = join(app, 'Resources');
      mkdirSync(resources, { recursive: true });
      writeFileSync(join(resources, 'asset.txt'), 'cached asset');
      writeFileSync(
        join(app, 'Info.plist'),
        '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>Stamp</key><data>AAAA</data></dict></plist>',
      );
      chmodSync(resources, 0o555);
      try {
        const { run } = harness({ bundleExit: 1 });
        const result = await run({ cachedAppPath: app, exec: getExecutor() });
        expect(result.failed).toBe(true);
        expect(result.step).toBe('bundle');
        expect(existsSync(tmp)).toBe(false);
        expect(statSync(resources).mode & 0o777).toBe(0o555);
        expect(readFileSync(join(resources, 'asset.txt'), 'utf-8')).toBe('cached asset');
      } finally {
        chmodSync(resources, 0o755);
        rmSync(source, { recursive: true, force: true });
      }
    },
  );

  test('a bundle that exits 0 without writing the file is still a bundle failure', async () => {
    const { run } = harness({ bundleWritten: false });
    const result = await run();
    expect(result.failed).toBe(true);
    expect(result.step).toBe('bundle');
    expect(result.reason).toMatch(/wrote no main\.jsbundle/);
  });

  test('a hermesc crash fails at the hermesc step', async () => {
    const { run } = harness({ failOn: hermescPath(root) });
    const result = await run();
    expect(result.failed).toBe(true);
    expect(result.step).toBe('hermesc');
  });

  test('a codesign failure fails at the codesign step -- an unsigned swap is never handed back', async () => {
    const { run } = harness({ failOn: 'codesign' });
    const result = await run();
    expect(result.failed).toBe(true);
    expect(result.step).toBe('codesign');
    expect(result.appPath).toBeUndefined();
  });

  test('a clone copy that fails midway is removed before the plain cp -R, which would otherwise nest into it', async () => {
    const calls: Call[] = [];
    let first = true;
    let fallbackTargetExisted: boolean | undefined;
    const exec = makeExecutor({
      runFile: (file, args = []) => {
        calls.push({ op: 'runFile', file, args });
        if (file === 'cp' && first) {
          first = false;
          mkdirSync(args.at(-1)!);
          writeFileSync(join(args.at(-1)!, 'partial'), '');
          throw new Error('cp: clonefile failed');
        }
        if (file === 'cp' && fallbackTargetExisted === undefined) fallbackTargetExisted = existsSync(args.at(-1)!);
        if (file === 'plutil') throw new Error('Command failed: plutil\nNo value at that key path');
        return '';
      },
    });
    const { run } = harness();
    const result = await run({ exec });
    expect(result.ok).toBe(true);
    expect(calls[0]?.args?.[0]).toBe('-c');
    expect(calls[1]?.args).toEqual(['-R', cachedApp, join(tmp, 'Fixture.app')]);
    expect(fallbackTargetExisted).toBe(false);
  });
});

describe('assetCatalogTarget', () => {
  test('reads the RCTUseAssetCatalog opt-in with the values NSBundle boolValue accepts', () => {
    expect(assetCatalogTarget({})).toBeNull();
    expect(assetCatalogTarget({ RCTUseAssetCatalog: false })).toBeNull();
    expect(assetCatalogTarget({ RCTUseAssetCatalog: 'NO' })).toBeNull();
    for (const on of [true, 1, 'YES', 'true', '1']) {
      expect(assetCatalogTarget({ RCTUseAssetCatalog: on })).not.toBeNull();
    }
  });

  test("compiles for the built app's platform, minimum OS and device families", () => {
    expect(
      assetCatalogTarget({
        RCTUseAssetCatalog: true,
        DTPlatformName: 'iphonesimulator',
        MinimumOSVersion: '16.4',
        UIDeviceFamily: [1, 2],
      }),
    ).toEqual({ platform: 'iphonesimulator', minimumDeploymentTarget: '16.4', targetDevices: ['iphone', 'ipad'] });
  });
});

describe('swapJsBundle with the React Native asset catalog', () => {
  const infoPlist = {
    RCTUseAssetCatalog: true,
    DTPlatformName: 'iphonesimulator',
    MinimumOSVersion: '16.4',
    UIDeviceFamily: [1],
  };
  const staging = () => join(tmp, 'rn-assets');
  const catalogBundle = () => join(tmp, 'Fixture.app', 'RNAssets.bundle');
  const cachedCatalog = () => {
    mkdirSync(catalogBundle(), { recursive: true });
    writeFileSync(join(catalogBundle(), 'Assets.car'), 'cached build images');
  };
  const emitImageset = () => mkdirSync(join(staging(), 'RNAssets.xcassets', 'assets_images_logo.imageset'));
  const writeCar = (out: string) => writeFileSync(join(out, 'Assets.car'), 'new images');

  test('recompiles RNAssets.bundle from the new bundle instead of shipping the cached build images', async () => {
    cachedCatalog();
    const { calls, run } = harness({ infoPlist, onBundle: emitImageset, onActool: writeCar });
    const result = await run();
    expect(result.ok).toBe(true);
    const bundle = calls.find((c) => c.op === 'spawn');
    expect(bundle?.args?.slice(-2)).toEqual(['--asset-catalog-dest', staging()]);
    const actool = calls.find((c) => c.file === 'xcrun');
    expect(actool?.args).toEqual([
      'actool',
      join(staging(), 'RNAssets.xcassets'),
      '--compile',
      catalogBundle(),
      '--output-format',
      'human-readable-text',
      '--errors',
      '--warnings',
      '--notices',
      '--platform',
      'iphonesimulator',
      '--minimum-deployment-target',
      '16.4',
      '--target-device',
      'iphone',
    ]);
    expect(readFileSync(join(catalogBundle(), 'Assets.car'), 'utf-8')).toBe('new images');
    expect(readFileSync(join(catalogBundle(), 'Info.plist'), 'utf-8')).toMatch(/org\.reactjs\.RNAssets/);
    expect(calls.findIndex((c) => c.file === 'xcrun')).toBeLessThan(calls.findIndex((c) => c.file === 'codesign'));
  });

  test('removes the cached catalog when the new bundle has no images', async () => {
    cachedCatalog();
    const { calls, run } = harness({ infoPlist });
    const result = await run();
    expect(result.ok).toBe(true);
    expect(existsSync(catalogBundle())).toBe(false);
    expect(calls.some((c) => c.file === 'xcrun')).toBe(false);
  });

  test('an actool run that writes no Assets.car fails the swap, so a full build runs', async () => {
    cachedCatalog();
    const { calls, run } = harness({ infoPlist, onBundle: emitImageset });
    const result = await run();
    expect(result.failed).toBe(true);
    expect(result.step).toBe('actool');
    expect(calls.some((c) => c.file === 'codesign')).toBe(false);
  });

  test('an unreadable Info.plist fails the swap before bundling', async () => {
    const { calls, run } = harness({ failOn: 'plutil' });
    const result = await run();
    expect(result.failed).toBe(true);
    expect(result.step).toBe('catalog');
    expect(calls.some((c) => c.op === 'spawn')).toBe(false);
  });
});
