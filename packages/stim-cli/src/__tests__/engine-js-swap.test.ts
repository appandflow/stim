import type { ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  JS_BUNDLE_NAME,
  assetCatalogTarget,
  hermesEnabledFromProperties,
  hermescPath,
  swapJsBundle,
} from '../engine/js-swap.ts';
import { getExecutor } from '../exec.ts';
import { makeChildProcess, makeExecutor, makeWriter } from './_factories.ts';

describe('hermesEnabledFromProperties', () => {
  test('default is enabled: no file, no key, unparseable JSON', () => {
    expect(hermesEnabledFromProperties(null)).toBe(true);
    expect(hermesEnabledFromProperties('{}')).toBe(true);
    expect(hermesEnabledFromProperties('not json at all')).toBe(true);
    expect(hermesEnabledFromProperties('[]')).toBe(true);
  });
});

let root: string;
let tmp: string;
let home: string;
const cachedApp = '/cache/ios/k-release-sim/Fixture.app';

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-swap-home-'));
  process.env.STIM_HOME = home;
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'stim-swap-root-')));
  tmp = mkdtempSync(join(tmpdir(), 'stim-swap-tmp-'));
  for (const name of ['expo', 'react-native']) {
    const dir = join(root, 'node_modules', name);
    mkdirSync(dir, { recursive: true });
    const bin = join(dir, 'cli.js');
    writeFileSync(bin, '#!/usr/bin/env node\n');
    chmodSync(bin, 0o755);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, bin: { [name]: 'cli.js' } }));
  }
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  delete process.env.STIM_HOME;
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
  opts?: Record<string, unknown>;
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
  const spawnFn = (cmd: string, args: string[], opts: Record<string, unknown>) => {
    calls.push({ op: 'spawn', file: cmd, args, opts });
    onBundle();
    return makeBundleChild(bundleExit);
  };
  const exists = (p: string) => {
    if (p === hermescPath(root, join(root, 'ios'))) return hermescExists;
    if (p === bundleOutput) return bundleWritten;
    return existsSync(p);
  };
  const writer = makeWriter();
  const run = (overrides: Record<string, unknown> = {}) =>
    swapJsBundle({
      root,
      iosDir: join(root, 'ios'),
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
  test('bare project: the bundle step is `react-native bundle` with the detected entry file', async () => {
    const { calls, run } = harness();
    const result = await run({ isExpo: false });
    expect(result.ok).toBe(true);
    const bundle = calls.find((c) => c.op === 'spawn');
    expect(bundle?.args?.slice(process.platform === 'win32' ? 1 : 0, process.platform === 'win32' ? 2 : 1)).toEqual([
      'bundle',
    ]);
    expect(bundle?.args).toContain('--entry-file');
  });

  test('hermesc missing is the GUARD, not a failure: plain JS bundle plus a note', async () => {
    const { calls, run } = harness({ hermescExists: false });
    const result = await run();
    expect(result.ok).toBe(true);
    expect(result.hermes).toBe(false);
    expect(result.note).toMatch(/hermesc not found/);
    expect(calls.some((c) => c.file === hermescPath(root, join(root, 'ios')))).toBe(false);
    expect(calls.at(-1)?.file).toBe('codesign');
  });

  test.skipIf(process.platform !== 'darwin')(
    'an Info.plist holding <data> and <date> still reads as no catalog with the real plutil (macOS only)',
    async () => {
      const source = mkdtempSync(join(tmpdir(), 'stim-plist-app-'));
      const app = join(source, 'Fixture.app');
      mkdirSync(app);
      writeFileSync(
        join(app, 'Info.plist'),
        '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>' +
          '<key>Stamp</key><data>AAAA</data><key>Built</key><date>2026-09-28T12:00:00Z</date></dict></plist>',
      );
      try {
        const { calls, run } = harness({ bundleExit: 1 });
        const result = await run({ cachedAppPath: app, exec: getExecutor() });
        expect(result.step).toBe('bundle');
        expect(calls.find((c) => c.op === 'spawn')?.args).not.toContain('--asset-catalog-dest');
      } finally {
        rmSync(source, { recursive: true, force: true });
      }
    },
  );
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

  test('an actool run that writes no Assets.car fails the swap, so a full build runs', async () => {
    cachedCatalog();
    const { calls, run } = harness({ infoPlist, onBundle: emitImageset });
    const result = await run();
    expect(result.failed).toBe(true);
    expect(result.step).toBe('actool');
    expect(calls.some((c) => c.file === 'codesign')).toBe(false);
  });
});
