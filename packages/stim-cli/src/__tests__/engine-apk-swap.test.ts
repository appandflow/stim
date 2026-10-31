import type { ChildProcess } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  ANDROID_BUNDLE_NAME,
  androidHermescPath,
  hermesEnabledFromGradleProperties,
  hermescBinDir,
  hermescCandidates,
  keystorePassArg,
  KEYSTORE_PASSWORD_ENV,
  readAndroidHermesEnabled,
  resolveKeystore,
  swapApkBundle,
} from '../engine/apk-swap.ts';
import { ASSET_MANIFEST_VERSION, type AssetManifest } from '../engine/asset-manifest.ts';
import type { BuildToolsEntry } from '../devices/android.ts';
import type { ExecOptions } from '../exec.ts';
import { makeChildProcess, makeExecutor, makeWriter } from './_factories.ts';
import { androidLayoutSetting, defaultAndroidLayout } from '../workspace/settings.ts';

describe('hermesEnabledFromGradleProperties', () => {
  test('default is enabled: no file, no key, an unrelated file', () => {
    expect(hermesEnabledFromGradleProperties(null)).toBe(true);
    expect(hermesEnabledFromGradleProperties('')).toBe(true);
    expect(hermesEnabledFromGradleProperties('newArchEnabled=true\n')).toBe(true);
    expect(hermesEnabledFromGradleProperties('hermesEnabled=true\n')).toBe(true);
  });

  test('readAndroidHermesEnabled reads the Gradle root when the module properties do not set the flag', () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'stim-apk-swap-')));
    try {
      const app = join(repo, 'packages', 'tester');
      mkdirSync(join(app, 'android', 'app'), { recursive: true });
      writeFileSync(join(repo, 'settings.gradle.kts'), '');
      writeFileSync(join(repo, 'gradle.properties'), 'hermesEnabled=false\n');
      writeFileSync(join(app, 'android', 'app', 'build.gradle.kts'), '');
      writeFileSync(join(app, 'android', 'app', 'gradle.properties'), 'android.useAndroidX=true\n');
      const layout = androidLayoutSetting(
        { android: { gradleRoot: '../..', module: ':packages:tester:android:app' } },
        app,
        repo,
      );
      expect(readAndroidHermesEnabled(app, layout)).toBe(false);
      expect(readAndroidHermesEnabled(app)).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('the hermesc probe order', () => {
  test('the host directory and the executable name are the only platform-dependent pieces', () => {
    expect(hermescBinDir('darwin')).toBe('osx-bin');
    expect(hermescBinDir('linux')).toBe('linux64-bin');
    expect(hermescBinDir('win32')).toBe('win64-bin');
    expect(hermescCandidates('/proj', { platform: 'win32' })).toEqual([
      join('/proj/node_modules/hermes-compiler/hermesc/win64-bin/hermesc.exe'),
      join('/proj/node_modules/react-native/sdks/hermesc/win64-bin/hermesc.exe'),
      join('/proj/node_modules/react-native/sdks/hermes/build/bin/hermesc.exe'),
    ]);
  });
});

describe('keystore resolution', () => {
  describe('a keystore from the committed .stim.json', () => {
    let repo: string;
    let outside: string;
    beforeEach(() => {
      repo = realpathSync(mkdtempSync(join(tmpdir(), 'stim-ks-repo-')));
      outside = realpathSync(mkdtempSync(join(tmpdir(), 'stim-ks-out-')));
      mkdirSync(join(repo, 'keys'));
      writeFileSync(join(repo, 'keys', 'release.jks'), 'k');
      writeFileSync(join(outside, 'release.jks'), 'k');
      symlinkSync(join(outside, 'release.jks'), join(repo, 'keys', 'link.jks'));
    });
    afterEach(() => {
      rmSync(repo, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    });
    const resolve = (keystore: string) =>
      resolveKeystore(repo, { android: { keystore } }, defaultAndroidLayout(repo), repo).path;

    test('an absolute path outside the repository, a ../ escape and a symlink out are refused', () => {
      for (const escape of [
        join(outside, 'release.jks'),
        '../' + basename(outside) + '/release.jks',
        'keys/link.jks',
      ]) {
        expect(() => resolve(escape)).toThrow(/Could not use android\.keystore .* from the committed \.stim\.json/);
      }
    });
  });

  test('a literal android.keystorePassword reaches apksigner through its environment, and a reference passes through', () => {
    const literal = { pass: `env:${KEYSTORE_PASSWORD_ENV}`, password: 'hunter2' };
    expect(keystorePassArg(undefined)).toEqual({ pass: 'pass:android', password: null });
    expect(keystorePassArg('   ')).toEqual({ pass: 'pass:android', password: null });
    expect(keystorePassArg('hunter2')).toEqual(literal);
    expect(keystorePassArg('pass:hunter2')).toEqual(literal);
    expect(keystorePassArg('env:MY_KS_PASS')).toEqual({ pass: 'env:MY_KS_PASS', password: null });
    expect(keystorePassArg('file:/keys/pw.txt')).toEqual({ pass: 'file:/keys/pw.txt', password: null });
    expect(keystorePassArg('stdin')).toEqual({ pass: 'stdin', password: null });
    expect(resolveKeystore('/w/app', { android: { keystorePassword: 'env:KS' } }).pass).toBe('env:KS');
  });
});

let root: string;
let tmp: string;
let cachedApk: string;
let home: string;
const keystore = { path: '/w/app/android/app/debug.keystore', pass: 'pass:android', password: null };
const buildTools: BuildToolsEntry = {
  path: '/sdk/build-tools/36.0.0/zipalign',
  tool: 'zipalign',
  version: '36.0.0',
  major: 36,
};
const apksigner = join('/sdk/build-tools/36.0.0', process.platform === 'win32' ? 'apksigner.bat' : 'apksigner');

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-apk-home-'));
  process.env.STIM_HOME = home;
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'stim-apk-root-')));
  tmp = mkdtempSync(join(tmpdir(), 'stim-apk-tmp-'));
  cachedApk = join(root, 'app-production-release.apk');
  writeFileSync(cachedApk, 'cached apk bytes');
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
  opts?: ExecOptions;
}

function manifest(assets: Record<string, string>): AssetManifest {
  return {
    version: ASSET_MANIFEST_VERSION,
    assets: Object.entries(assets)
      .map(([path, sha256]) => ({ path, sha256 }))
      .toSorted((a, b) => a.path.localeCompare(b.path)),
  };
}

const LOGO = 'a'.repeat(64);
const SOUND = 'b'.repeat(64);
const STORED = manifest({ 'drawable-mdpi/logo.png': LOGO, 'raw/sound.mp3': SOUND });

function harness({
  bundleExit = 0,
  failOn = null as string | null,
  hermescExists = true,
  bundleWritten = true,
  fresh = STORED as AssetManifest | null,
  stored = STORED as AssetManifest | null,
  embeddedManifest = null as string | null,
} = {}) {
  const calls: Call[] = [];
  const base = 'app-production-release.apk';
  const work = join(tmp, `unaligned-${base}`);
  const final = join(tmp, base);
  const stage = join(tmp, 'stage');
  const bundleOutput = join(stage, 'assets', ANDROID_BUNDLE_NAME);
  const hermesc = androidHermescPath(root, { exists: () => false });
  const exec = makeExecutor({
    runFile: (file: string, args: string[], opts: ExecOptions) => {
      calls.push({ op: 'runFile', file, args, opts });
      if (failOn && (file === failOn || args[0] === failOn)) throw new Error(`${failOn} blew up`);
      if (file === hermesc) writeFileSync(args[args.indexOf('-out') + 1]!, 'hermes bytecode');
      if (file === 'cp') writeFileSync(args[2]!, 'cloned apk bytes');
      if (args[0] === '--extract' && embeddedManifest !== null) {
        mkdirSync(join(String(opts.cwd), 'assets'), { recursive: true });
        writeFileSync(join(String(opts.cwd), 'assets', 'app.manifest'), embeddedManifest);
      }
      return '';
    },
  });
  const spawnFn = (cmd: string, args: string[], _opts: Record<string, unknown>) => {
    calls.push({ op: 'spawn', file: cmd, args });
    return makeBundleChild(bundleExit);
  };
  const exists = (p: string) => {
    if (p === hermesc) return hermescExists;
    if (p === bundleOutput) return bundleWritten;
    return existsSync(p);
  };
  const writer = makeWriter();
  const run = (overrides: Record<string, unknown> = {}) =>
    swapApkBundle({
      root,
      isExpo: true,
      cachedApkPath: cachedApk,
      keystore,
      logWriter: writer,
      exec,
      spawnFn,
      mkdtemp: () => tmp,
      exists,
      buildTools,
      storedAssets: stored,
      readManifest: () => fresh,
      heartbeatMs: 0,
      platform: 'linux',
      ...overrides,
    });
  return { calls, run, work, final, stage, bundleOutput, hermesc, writer };
}

describe('swapApkBundle', () => {
  test('the order IS the product: copy aside, bundle, hermesc, asset gate, jar update, zipalign, apksigner -- and the cache entry is never written', async () => {
    const { calls, run, work, final, stage, bundleOutput, hermesc } = harness();
    const result = await run();
    expect(result.ok).toBe(true);
    expect(result.apkPath).toBe(final);
    expect(result.tmpDir).toBe(tmp);
    expect(result.hermes).toBe(true);

    expect(calls.map((c) => c.file)).toEqual([
      process.platform === 'win32' ? process.execPath : join(root, 'node_modules', 'expo', 'cli.js'),
      hermesc,
      expect.stringMatching(/(?:^|[\\/])jar(?:\.exe)?$/),
      expect.stringMatching(/(?:^|[\\/])jar(?:\.exe)?$/),
      buildTools.path,
      apksigner,
    ]);

    expect(readFileSync(work, 'utf-8')).toBe('cached apk bytes');
    expect(readFileSync(cachedApk, 'utf-8')).toBe('cached apk bytes');
    for (const call of calls) expect(call.args ?? []).not.toContain(cachedApk);

    const bundle = calls[0];
    expect(bundle?.args?.slice(process.platform === 'win32' ? 1 : 0, process.platform === 'win32' ? 4 : 3)).toEqual([
      'export:embed',
      '--platform',
      'android',
    ]);
    expect(bundle?.args).toContain(join(stage, 'assets', 'index.android.bundle'));
    expect(bundle?.args).toContain(join(stage, 'res'));

    expect(readFileSync(bundleOutput, 'utf-8')).toBe('hermes bytecode');
    expect(existsSync(`${bundleOutput}.hbc`)).toBe(false);

    expect(calls[2]?.args).toEqual(['--extract', '--file', work, 'assets/app.manifest']);
    expect(calls[2]?.opts?.cwd).toBe(stage);
    expect(existsSync(join(stage, 'assets', 'app.manifest'))).toBe(false);
    expect(calls[3]?.args).toEqual(['--update', '--file', work, '--no-compress', '-C', stage, 'assets']);

    expect(calls[4]?.args).toEqual(['-P', '16', '-f', '-v', '4', work, final]);
    expect(calls[5]?.args).toEqual(['sign', '--ks', keystore.path, '--ks-pass', 'pass:android', final]);
  });

  test('the expo-updates embedded manifest is repacked with a fresh id and this swap as its commitTime', async () => {
    const embeddedManifest = JSON.stringify({ id: 'build-id', commitTime: 1000, assets: [] });
    const { run, stage } = harness({ embeddedManifest });
    const result = await run({ now: () => 5000 });
    expect(result.ok).toBe(true);
    const refreshed = JSON.parse(readFileSync(join(stage, 'assets', 'app.manifest'), 'utf-8'));
    expect(refreshed).toMatchObject({ commitTime: 5000, assets: [] });
    expect(refreshed.id).not.toBe('build-id');
  });

  test('an unreadable embedded manifest fails the swap before the APK is repacked', async () => {
    const { run, calls } = harness({ embeddedManifest: 'not json' });
    const result = await run();
    expect(result.failed).toBe(true);
    expect(result.step).toBe('updates');
    expect(calls.map((c) => c.args?.[0])).not.toContain('--update');
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
    const { calls, run, hermesc } = harness({ hermescExists: false });
    const result = await run();
    expect(result.ok).toBe(true);
    expect(result.hermes).toBe(false);
    expect(result.note).toMatch(/hermesc not found/);
    expect(calls.some((c) => c.file === hermesc)).toBe(false);
    expect(calls.at(-1)?.file).toBe(apksigner);
  });

  test('an asset the cached build emitted and this one no longer does refuses the swap too', async () => {
    const { run } = harness({ fresh: manifest({ 'drawable-mdpi/logo.png': LOGO }) });
    const result = await run();
    expect(result.assetMismatch).toBe(true);
    expect(existsSync(tmp)).toBe(false);
    expect(result.assetDiff?.removed).toEqual(['raw/sound.mp3']);
  });

  test('an entry with NO manifest is never swapped, and says so distinctly', async () => {
    const { calls, run } = harness({ stored: null });
    const result = await run();
    expect(result.assetMismatch).toBe(true);
    expect(existsSync(tmp)).toBe(false);
    expect(result.assetDiff).toBeUndefined();
    expect(result.reason).toMatch(/predates asset tracking/);
    expect(calls.some((c) => c.file === 'zip')).toBe(false);
    expect(calls.some((c) => c.file === apksigner)).toBe(false);
  });

  test('a literal keystore password is handed to apksigner in its environment, never on its command line', async () => {
    const { calls, run } = harness();
    const result = await run({ keystore: resolveKeystore(root, { android: { keystorePassword: 'hunter2' } }) });
    expect(result.ok).toBe(true);
    const sign = calls.find((c) => c.file === apksigner);
    expect(sign?.args).toContain(`env:${KEYSTORE_PASSWORD_ENV}`);
    expect(sign?.args?.join(' ')).not.toContain('hunter2');
    expect(sign?.opts).toMatchObject({
      timeoutMs: 'unbounded',
      env: { [KEYSTORE_PASSWORD_ENV]: 'hunter2' },
      redact: ['hunter2'],
    });
  });

  test('an apksigner failure fails at the apksigner step -- an unsigned APK is never handed back', async () => {
    const { run } = harness({ failOn: apksigner });
    const result = await run();
    expect(result.failed).toBe(true);
    expect(result.step).toBe('apksigner');
    expect(result.apkPath).toBeUndefined();
  });

  test('darwin clones the cached APK with cp -c and falls back to a plain copy when cp refuses', async () => {
    const { calls, run, work } = harness();
    expect((await run({ platform: 'darwin' })).ok).toBe(true);
    expect(calls[0]).toMatchObject({ file: 'cp', args: ['-c', cachedApk, work] });
    expect(readFileSync(work, 'utf-8')).toBe('cloned apk bytes');

    const { calls: refused, run: rerun, work: work2 } = harness({ failOn: 'cp' });
    expect((await rerun({ platform: 'darwin' })).ok).toBe(true);
    expect(refused[0]?.file).toBe('cp');
    expect(refused.filter((c) => c.file === 'cp')).toHaveLength(1);
    expect(readFileSync(work2, 'utf-8')).toBe('cached apk bytes');
  });

  test('win32 and linux never shell out to cp', async () => {
    for (const platform of ['win32', 'linux'] as const) {
      const { calls, run, work } = harness();
      expect((await run({ platform })).ok).toBe(true);
      expect(calls.some((c) => c.file === 'cp')).toBe(false);
      expect(readFileSync(work, 'utf-8')).toBe('cached apk bytes');
    }
  });
});
