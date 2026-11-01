import type { ChildProcess } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  JS_BUNDLE_NAME,
  assetCatalogTarget,
  hermesEnabledFromProperties,
  hermescPath,
  swapBundlerEnv,
  swapJsBundle,
} from '../engine/js-swap.ts';
import { workspaceDir } from '../workspace/paths.ts';
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

describe('swapBundlerEnv', () => {
  test('keeps the Metro cache while the EXPO_PUBLIC_ values and .env files match, and empties it when they change', () => {
    const env = { PATH: '/bin', EXPO_PUBLIC_API_URL: 'https://a.example' };
    const dir = String(swapBundlerEnv(root, env).TMPDIR);
    expect(dir.startsWith(workspaceDir(root))).toBe(true);
    const marker = join(dir, 'metro-cache', 'entry');
    const seed = () => {
      mkdirSync(join(dir, 'metro-cache'), { recursive: true });
      writeFileSync(marker, 'transform');
    };

    seed();
    expect(swapBundlerEnv(root, { ...env, PATH: '/usr/bin' }).TMPDIR).toBe(dir);
    expect(existsSync(marker)).toBe(true);

    expect(swapBundlerEnv(root, { ...env, EXPO_PUBLIC_API_URL: 'https://b.example' }).TMPDIR).toBe(dir);
    expect(existsSync(marker)).toBe(false);

    seed();
    expect(swapBundlerEnv(root, { PATH: '/bin' }).TMPDIR).toBe(dir);
    expect(existsSync(marker)).toBe(false);

    seed();
    swapBundlerEnv(root, { PATH: '/bin', EXPO_NO_DOTENV: '1' });
    expect(existsSync(marker)).toBe(false);

    seed();
    writeFileSync(join(root, '.env.production'), 'EXPO_PUBLIC_API_URL=https://c.example\n');
    swapBundlerEnv(root, { PATH: '/bin' });
    expect(existsSync(marker)).toBe(false);
  });
});

describe('swapJsBundle', () => {
  test('the order IS the product: copy aside, bundle, hermesc, replace, re-sign -- and the cache entry is never written', async () => {
    const { calls, run, appCopy, bundleOutput } = harness();
    const result = await run();
    expect(result.ok).toBe(true);
    expect(result.appPath).toBe(appCopy);
    expect(result.tmpDir).toBe(tmp);
    expect(result.hermes).toBe(true);

    const shape = calls.map((c) => c.file);
    expect(shape).toEqual([
      'cp',
      'plutil',
      process.platform === 'win32' ? process.execPath : join(root, 'node_modules', 'expo', 'cli.js'),
      hermescPath(root, join(root, 'ios')),
      'mv',
      'cp',
      'cp',
      'codesign',
    ]);

    const copyAside = calls[0];
    expect(copyAside?.args).toEqual(['-c', '-R', cachedApp, appCopy]);
    const bundle = calls[2];
    expect(bundle?.args?.slice(process.platform === 'win32' ? 1 : 0, process.platform === 'win32' ? 2 : 1)).toEqual([
      'export:embed',
    ]);
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

  test('a codesign failure fails at the codesign step -- an unsigned swap is never handed back', async () => {
    const { run } = harness({ failOn: 'codesign' });
    const result = await run();
    expect(result.failed).toBe(true);
    expect(result.step).toBe('codesign');
    expect(result.appPath).toBeUndefined();
  });
});

describe('the expo-updates embedded manifest in a swapped copy', () => {
  const EMBEDDED = JSON.stringify({ id: 'build-id', commitTime: 1000, assets: [{ name: 'logo', type: 'png' }] });
  const writeManifest = (dir: string, text = EMBEDDED) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'app.manifest'), text);
  };

  test('gets a fresh id and a commitTime from this swap, so an update downloaded after the cached build cannot outrank it', async () => {
    const { run, appCopy, calls } = harness({
      onBundle: () => writeManifest(join(tmp, 'Fixture.app', 'EXUpdates.bundle')),
    });
    const result = await run({ now: () => 5000 });
    expect(result.ok).toBe(true);
    const refreshed = JSON.parse(readFileSync(join(appCopy, 'EXUpdates.bundle', 'app.manifest'), 'utf-8'));
    expect(refreshed.commitTime).toBe(5000);
    expect(refreshed.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(refreshed.id).not.toBe('build-id');
    expect(calls.at(-1)?.file).toBe('codesign');
  });

  test('a manifest inside a nested dynamic framework fails the swap, since re-signing only the app would break that seal', async () => {
    const { run, calls } = harness({
      onBundle: () => writeManifest(join(tmp, 'Fixture.app', 'Frameworks', 'EXUpdates.framework', 'EXUpdates.bundle')),
    });
    const result = await run();
    expect(result.failed).toBe(true);
    expect(result.step).toBe('updates');
    expect(calls.map((c) => c.file)).not.toContain('codesign');
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
