import assert from 'node:assert';
import { makeExecutor } from './_factories.ts';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetExecutor, setExecutor } from '../exec.ts';
import type { NdjsonRecord, NdjsonWriter } from '../ndjson.ts';
import { workspaceDerivedData } from '../workspace/paths.ts';
import { readManifest } from '../cache/cache-manifest.ts';
import { claimForEmptying } from '../cache/cache-claim.ts';
import { releaseClaim } from '../ownership-claim.ts';
import {
  buildIos,
  reactNativeCompilationCacheSettings as compilationCacheSettings,
  parseReactNativeVersion,
  discoverXcodeProject,
} from '../integrations/react-native-build.ts';
import {
  buildXcode,
  compilationCacheActivityLine,
  parseBundleExecutable,
  parseSchemeList,
  pickAppBundle,
  pickScheme,
  pickXcodeProject,
  productsDir,
  readBundleExecutable,
  readBundleId,
  resolveScheme,
} from '../engine/xcode.ts';

let tmp: string;
let stateHome: string;
let previousStateHome: string | undefined;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'stim-xcode-'));
  stateHome = mkdtempSync(join(tmpdir(), 'stim-xcode-state-'));
  previousStateHome = process.env.STIM_HOME;
  process.env.STIM_HOME = stateHome;
});
afterEach(() => {
  resetExecutor();
  rmSync(tmp, { recursive: true, force: true });
  rmSync(stateHome, { recursive: true, force: true });
  if (previousStateHome === undefined) delete process.env.STIM_HOME;
  else process.env.STIM_HOME = previousStateHome;
});

function recordingWriter(file = '/dev/null/not-used'): NdjsonWriter & { records: NdjsonRecord[] } {
  const records: NdjsonRecord[] = [];
  return {
    file,
    records,
    write(record: unknown) {
      records.push(record as NdjsonRecord);
      return true;
    },
    close() {
      return { file, written: records.length, dropped: 0, lastError: null };
    },
    written: 0,
    dropped: 0,
    lastError: null,
  };
}

type FakeChild = EventEmitter & {
  pid: number;
  stdout: EventEmitter;
  stderr: EventEmitter;
  started: Promise<void>;
  start(): void;
};

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.started = new Promise<void>((resolve) => {
    child.start = resolve;
  });
  child.pid = 424242;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

type BuildIosArgs = Parameters<typeof buildIos>[0];

function stubProject(root: string, { workspace = false, project = true, name = 'App' } = {}) {
  const ios = join(root, 'ios');
  mkdirSync(ios, { recursive: true });
  if (project) mkdirSync(join(ios, `${name}.xcodeproj`));
  if (workspace) mkdirSync(join(ios, `${name}.xcworkspace`));
  return ios;
}

describe('pickXcodeProject', () => {
  test('among several workspaces, the one named after a project beside it wins', () => {
    const picked = pickXcodeProject(['Other.xcworkspace', 'App.xcworkspace', 'App.xcodeproj']);
    assert(picked);
    expect(picked.file).toBe('App.xcworkspace');
  });
});

describe('discoverXcodeProject', () => {
  test('an ios/ directory with nothing buildable in it says exactly that', () => {
    mkdirSync(join(tmp, 'ios'), { recursive: true });
    writeFileSync(join(tmp, 'ios', 'Podfile'), 'platform :ios');
    const { error } = discoverXcodeProject(tmp, join(tmp, 'ios'));
    assert(error);
    expect(error.code).toBe('STIM_BUILD_FAILED');
    expect(error.message).toMatch(/contains no \.xcworkspace and no \.xcodeproj/);
    expect(error.remedy).toMatch(/prebuild/);
  });
});

describe('parseSchemeList', () => {
  test('garbage is the empty listing rather than a parse error reaching the user', () => {
    const empty = { name: null, schemes: [] };
    expect(parseSchemeList('not json at all')).toEqual(empty);
    expect(parseSchemeList('{ broken')).toEqual(empty);
    expect(parseSchemeList('{}')).toEqual(empty);
    expect(parseSchemeList('{"project":{"name":"A"}}')).toEqual({ name: 'A', schemes: [] });
    expect(parseSchemeList('')).toEqual(empty);
    expect(parseSchemeList(null)).toEqual(empty);
  });
});

describe('pickScheme', () => {
  test('no schemes is null, and so is nonsense input', () => {
    expect(pickScheme([], 'App')).toBe(null);
    expect(pickScheme(null, 'App')).toBe(null);
    expect(pickScheme(['App'], null)).toBe('App');
  });
});

describe('listSchemes and resolveScheme', () => {
  const project = { flag: '-project', path: '/p/ios/App.xcodeproj', name: 'App', dir: '/p/ios' };

  test('an empty scheme listing keeps the share-scheme remedy', async () => {
    setExecutor({
      run: () => '',
      runQuiet: () => null,
      spawn: () => {},
      runFile: () => '{"workspace":{"name":"App","schemes":[]}}',
    });
    expect((await resolveScheme(project)).error?.remedy).toMatch(/tick Shared/);
  });
});

describe('compilationCacheSettings', () => {
  const base = {
    workspaceRoot: '/w/app-412',
    derivedDataPath: '/home/.stim/workspaces/app-412--abc/derived-data',
    casPath: '/home/.stim/compilation-cache',
  };

  test('explicit switches override project-enabled caching and prefix mapping while allowing Swift caching', () => {
    const options = { compilationCache: false, swiftCompilationCache: true, prefixMapping: false };
    const settings = compilationCacheSettings({ ...base, xcodeMajor: 26, optimizations: options });
    expect(settings).toContain('COMPILATION_CACHE_ENABLE_CACHING=NO');
    expect(settings).toContain('SWIFT_ENABLE_COMPILE_CACHE=NO');
    expect(
      compilationCacheSettings({ ...base, xcodeMajor: 26, optimizations: { ...options, compilationCache: true } }),
    ).toContain('SWIFT_ENABLE_COMPILE_CACHE=YES');
    expect(settings).toContain('CLANG_ENABLE_PREFIX_MAPPING=NO');
    expect(settings).toContain('CLANG_OTHER_PREFIX_MAPPINGS=');
    expect(compilationCacheSettings({ ...base, xcodeMajor: 25, optimizations: options })).toEqual([]);
    expect(compilationCacheSettings({ ...base, xcodeMajor: 26, ccache: true, optimizations: options })).toEqual([]);
  });

  test('parseReactNativeVersion reads major.minor from the package manifest and rejects the rest', () => {
    expect(parseReactNativeVersion({ version: '0.87.0' })).toEqual({ major: 0, minor: 87 });
    expect(parseReactNativeVersion({ version: '0.88.0-rc.1' })).toEqual({ major: 0, minor: 88 });
    expect(parseReactNativeVersion({ version: '0.89.0-nightly-20260918-d2a6ce5f7' })).toEqual({ major: 0, minor: 89 });
    for (const bad of [null, {}, { version: 'latest' }, { version: 87 }, 'text']) {
      expect(parseReactNativeVersion(bad)).toBe(null);
    }
  });
});

describe('locating the product', () => {
  test('with one .app the name does not matter, and with none it is null', () => {
    expect(pickAppBundle(['Something.app'], 'Other')).toBe('Something.app');
    expect(pickAppBundle(['App.dSYM', 'App.swiftmodule'], 'App')).toBe(null);
    expect(pickAppBundle([], null)).toBe(null);
    expect(pickAppBundle(null, null)).toBe(null);
  });
});

describe('reading the bundle id', () => {
  test('reads a binary Info.plist in process when neither plutil nor defaults exists', async () => {
    const value = 'com.example.app';
    const string = (text: string) => Buffer.concat([Buffer.from([0x5f, 0x10, text.length]), Buffer.from(text)]);
    const objects = [Buffer.from([0xd1, 1, 2]), string('CFBundleIdentifier'), string(value)];
    const offsets = objects.map((_, i) => 8 + objects.slice(0, i).reduce((n, o) => n + o.length, 0));
    const tableAt = 8 + objects.reduce((n, o) => n + o.length, 0);
    const trailer = Buffer.alloc(32);
    trailer.writeUInt8(1, 6);
    trailer.writeUInt8(1, 7);
    trailer.writeBigUInt64BE(3n, 8);
    trailer.writeBigUInt64BE(BigInt(tableAt), 24);
    const dir = mkdtempSync(join(tmpdir(), 'stim-bplist-'));
    const app = join(dir, 'App.app');
    mkdirSync(app);
    writeFileSync(
      join(app, 'Info.plist'),
      Buffer.concat([Buffer.from('bplist00'), ...objects, Buffer.from(offsets), trailer]),
    );
    setExecutor({
      run: () => '',
      runQuiet: () => null,
      spawn: () => {},
      runFile: () => {
        throw Object.assign(new Error('spawnSync ENOENT'), { code: 'ENOENT' });
      },
    });
    try {
      expect(await readBundleId(app)).toBe(value);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('reading the bundle executable', () => {
  test('anything else is null, so the caller falls back to the .app basename', () => {
    expect(parseBundleExecutable('{"CFBundleIdentifier":"com.example.app"}')).toBe(null);
    expect(parseBundleExecutable('{"CFBundleExecutable":""}')).toBe(null);
    expect(parseBundleExecutable('{"CFBundleExecutable":42}')).toBe(null);
    expect(parseBundleExecutable('not json')).toBe(null);
    expect(parseBundleExecutable(null)).toBe(null);
  });

  test('falls back to `defaults read`, which takes the path WITHOUT the extension', async () => {
    const calls: string[] = [];
    setExecutor({
      run: () => '',
      runQuiet: () => null,
      spawn: () => {},
      runFile: (file, _args) => {
        calls.push(file);
        if (file === 'plutil') throw new Error('plutil missing');
        return 'App\n';
      },
    });
    expect(await readBundleExecutable('/dd/App.app')).toBe('App');
    expect(calls).toEqual(['plutil', 'defaults']);
  });
});

describe('buildIos with a mocked executor', () => {
  function harness(
    root: string,
    {
      child,
      listing = '{"project":{"name":"App","schemes":["App"]}}',
      bundleId = 'com.example.app',
    }: { child?: FakeChild; listing?: string; bundleId?: string | null } = {},
  ) {
    const spawnCalls: { cmd: string; args: readonly string[] | undefined; opts: SpawnOptions | undefined }[] = [];
    setExecutor({
      run: () => '',
      runFileQuietAsync: async () => null,
      runFile: (file, args) => {
        if (file === 'xcodebuild') return listing;
        if (file === 'plutil') {
          if (bundleId === null) throw new Error('plutil: cannot read');
          return JSON.stringify({ CFBundleIdentifier: bundleId });
        }
        throw new Error(`unexpected runFile ${file} ${args.join(' ')}`);
      },
      spawn: (cmd, args, opts) => {
        spawnCalls.push({ cmd, args, opts });
        child?.start();
        return child as unknown as ChildProcess;
      },
    });
    stubProject(root, { name: 'App' });
    return spawnCalls;
  }

  function makeProduct(derivedDataPath: string, name = 'App', variant: { configuration?: string; sdk?: string } = {}) {
    const dir = productsDir(derivedDataPath, variant);
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(dir, `${name}.app`), { recursive: true });
    return join(dir, `${name}.app`);
  }

  test('an injected set of settings lands on the argv, after the action', async () => {
    const child = fakeChild();
    const spawnCalls = harness(tmp, { child });
    const promise = buildIos({
      root: tmp,
      iosDir: join(tmp, 'ios'),
      udid: 'BF2A-1111-2222',
      logWriter: recordingWriter(),
      compilationCache: ['COMPILATION_CACHE_ENABLE_CACHING=YES', `COMPILATION_CACHE_CAS_PATH=${join(tmp, 'cas')}`],
    });
    await child.started;
    expect(spawnCalls[0]?.args?.slice(-4)).toEqual([
      'build',
      'COMPILATION_CACHE_ENABLE_CACHING=YES',
      `COMPILATION_CACHE_CAS_PATH=${join(tmp, 'cas')}`,
      'DEBUG_INFORMATION_FORMAT=dwarf',
    ]);
    makeProduct(workspaceDerivedData(tmp));
    child.emit('close', 0, null);
    await promise;
  });

  test('the resolved settings produce ONE stderr note naming the CAS path, and land on the argv', async () => {
    const notes: string[] = [];
    const child = fakeChild();
    const spawnCalls = harness(tmp, { child });
    setExecutor({
      run: () => '',
      runFileQuietAsync: async (cmd) =>
        cmd === 'xcrun'
          ? 'Apple Swift version 6.3.3 (swiftlang-6.3.3.1.3 clang-2100.1.1.101)\n'
          : 'Xcode 26.1\nBuild version 17B55\n',
      runFile: (file) => (file === 'xcodebuild' ? '{"project":{"name":"App","schemes":["App"]}}' : '{}'),
      spawn: (cmd, args, opts) => {
        spawnCalls.push({ cmd, args, opts });
        child?.start();
        return child as unknown as ChildProcess;
      },
    });
    const promise = buildIos({
      root: tmp,
      iosDir: join(tmp, 'ios'),
      udid: 'BF2A-1111-2222',
      logWriter: recordingWriter(),
      onNote: (line) => notes.push(line),
    });
    await child.started;
    makeProduct(workspaceDerivedData(tmp));
    child.emit('close', 0, null);
    await promise;
    expect(notes.length).toBe(1);
    expect(notes[0]).toMatch(
      /^ {2}cache {7}compilation cache on \(CAS at .*compilation-cache, Swift off, 6\.3 < 6\.4\)$/,
    );
    const args = spawnCalls[0]?.args ?? [];
    expect(args).toContain('COMPILATION_CACHE_ENABLE_CACHING=YES');
    expect(args).toContain('SWIFT_ENABLE_COMPILE_CACHE=NO');
    expect(args).toContain('SWIFT_ENABLE_PREFIX_MAPPING=NO');
    expect(args).toContain(
      process.platform === 'win32'
        ? `CLANG_OTHER_PREFIX_MAPPINGS=${JSON.stringify(`${tmp}=/^src`)} ${JSON.stringify(`${workspaceDerivedData(tmp)}=/^derived-data`)}`
        : `CLANG_OTHER_PREFIX_MAPPINGS=${tmp}=/^src ${workspaceDerivedData(tmp)}=/^derived-data`,
    );
    expect(readManifest().caches).toContainEqual(
      expect.objectContaining({
        dir: join(stateHome, 'compilation-cache'),
        name: 'Xcode compilation cache',
        prune: 'atomic',
      }),
    );
  });

  function stubReactNative(root: string, version: string) {
    const dir = join(root, 'node_modules', 'react-native');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'react-native', version, main: 'index.js' }));
    writeFileSync(join(dir, 'index.js'), '');
  }

  test('a Swift 6.4 toolchain on React Native 0.86 leaves Swift off and says why', async () => {
    const notes: string[] = [];
    const child = fakeChild();
    const spawnCalls = harness(tmp, { child });
    stubReactNative(tmp, '0.86.3');
    setExecutor({
      run: () => '',
      runFileQuietAsync: async (cmd) =>
        cmd === 'xcrun'
          ? 'Apple Swift version 6.4 (swiftlang-6.4.0.1.2 clang-2200.0.1.3)\n'
          : 'Xcode 27.0\nBuild version 18A100\n',
      runFile: (file) => (file === 'xcodebuild' ? '{"project":{"name":"App","schemes":["App"]}}' : '{}'),
      spawn: (cmd, args, opts) => {
        spawnCalls.push({ cmd, args, opts });
        child?.start();
        return child as unknown as ChildProcess;
      },
    });
    const promise = buildIos({
      root: tmp,
      iosDir: join(tmp, 'ios'),
      udid: 'BF2A-1111-2222',
      logWriter: recordingWriter(),
      onNote: (line) => notes.push(line),
    });
    await child.started;
    makeProduct(workspaceDerivedData(tmp));
    child.emit('close', 0, null);
    await promise;
    expect(notes[0]).toMatch(
      /compilation cache on \(CAS at .*compilation-cache, Swift off, react-native 0\.86 < 0\.87\)$/,
    );
    const args = spawnCalls[0]?.args ?? [];
    expect(args).toContain('SWIFT_ENABLE_COMPILE_CACHE=NO');
    expect(args).toContain('SWIFT_ENABLE_PREFIX_MAPPING=NO');
  });

  test('a Swift 6.4 toolchain puts Swift caching and its mapping on the argv and names it on the note', async () => {
    const notes: string[] = [];
    const child = fakeChild();
    const spawnCalls = harness(tmp, { child });
    stubReactNative(tmp, '0.88.0-rc.0');
    setExecutor({
      run: () => '',
      runFileQuietAsync: async (cmd) =>
        cmd === 'xcrun'
          ? 'Apple Swift version 6.4 (swiftlang-6.4.0.1.2 clang-2200.0.1.3)\n'
          : 'Xcode 27.0\nBuild version 18A100\n',
      runFile: (file) => (file === 'xcodebuild' ? '{"project":{"name":"App","schemes":["App"]}}' : '{}'),
      spawn: (cmd, args, opts) => {
        spawnCalls.push({ cmd, args, opts });
        child?.start();
        return child as unknown as ChildProcess;
      },
    });
    const promise = buildIos({
      root: tmp,
      iosDir: join(tmp, 'ios'),
      udid: 'BF2A-1111-2222',
      logWriter: recordingWriter(),
      onNote: (line) => notes.push(line),
    });
    await child.started;
    makeProduct(workspaceDerivedData(tmp));
    child.emit('close', 0, null);
    await promise;
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/compilation cache on \(CAS at .*compilation-cache, Swift on\)$/);
    const args = spawnCalls[0]?.args ?? [];
    expect(args).toContain('SWIFT_ENABLE_COMPILE_CACHE=YES');
    expect(args).toContain('SWIFT_ENABLE_PREFIX_MAPPING=YES');
    expect(args).toContain(
      process.platform === 'win32'
        ? `SWIFT_OTHER_PREFIX_MAPPINGS=${JSON.stringify(`${tmp}=/^src`)} ${JSON.stringify(`${workspaceDerivedData(tmp)}=/^derived-data`)}`
        : `SWIFT_OTHER_PREFIX_MAPPINGS=${tmp}=/^src ${workspaceDerivedData(tmp)}=/^derived-data`,
    );
  });

  test('counts the Swift targets Xcode excluded from caching for lack of explicit modules', async () => {
    const child = fakeChild();
    harness(tmp, { child });
    const writer = recordingWriter();
    const dd = join(tmp, 'dd');
    const promise = buildIos({
      root: tmp,
      iosDir: join(tmp, 'ios'),
      udid: 'u',
      logWriter: writer,
      derivedDataPath: dd,
      compilationCache: ['COMPILATION_CACHE_ENABLE_CACHING=YES', 'SWIFT_ENABLE_COMPILE_CACHE=YES'],
    });
    await child.started;

    child.stdout.emit(
      'data',
      [
        "SwiftDriver ExpoCrypto normal arm64 com.apple.xcode.tools.swift.compiler (in target 'ExpoCrypto' from project 'Pods')",
        "warning: swift compiler caching requires explicit module build (SWIFT_ENABLE_EXPLICIT_MODULES=YES) (in target 'ExpoCrypto' from project 'Pods')",
        "warning: swift compiler caching requires explicit module build (SWIFT_ENABLE_EXPLICIT_MODULES=YES) (in target 'EXConstants' from project 'Pods')",
        "warning: Ignore '-scanner-prefix-*' options that cannot be used without compilation caching (in target 'ExpoCrypto' from project 'Pods')",
        'note: 1441 hits / 1441 cacheable tasks (100%)',
        '',
      ].join('\n'),
    );
    makeProduct(dd);
    child.emit('close', 0, null);
    const result = await promise;

    expect(result.compilationCache).toEqual({
      status: 'reported',
      hits: 1441,
      cacheableTasks: 1441,
      hitRatePercent: 100,
      swiftTargetsWithoutExplicitModules: 2,
    });
    expect(compilationCacheActivityLine(result.compilationCache)).toBe(
      '1441/1441 hits (100%); Swift excluded: 2 targets build without explicit modules (SWIFT_ENABLE_EXPLICIT_MODULES=NO)',
    );
    expect(writer.records).toContainEqual(
      expect.objectContaining({ event: 'compilation_cache', swiftTargetsWithoutExplicitModules: 2 }),
    );
  });

  test('a build waits for an emptier that holds the compilation cache, then compiles', async () => {
    const cas = join(tmp, 'cas');
    const emptying = claimForEmptying(cas);
    assert(typeof emptying !== 'string');
    const child = fakeChild();
    const spawnCalls = harness(tmp, { child });
    const notes: string[] = [];
    const promise = buildIos({
      root: tmp,
      iosDir: join(tmp, 'ios'),
      udid: 'u',
      logWriter: recordingWriter(),
      onHeartbeat: (line) => notes.push(line),
      compilationCache: ['COMPILATION_CACHE_ENABLE_CACHING=YES', `COMPILATION_CACHE_CAS_PATH=${cas}`],
    });
    await vi.waitFor(() => expect(notes.join('\n')).toContain('to finish emptying the compilation cache'));
    expect(spawnCalls).toEqual([]);
    releaseClaim(emptying);
    await child.started;
    child.emit('close', 65, null);
    await promise;
  });

  test('more than ten diagnostics are capped, and the rest are counted', async () => {
    const child = fakeChild();
    harness(tmp, { child });
    const writer = recordingWriter();
    const promise = buildIos({
      root: tmp,
      iosDir: join(tmp, 'ios'),
      udid: 'u',
      logWriter: writer,
      derivedDataPath: join(tmp, 'dd'),
    });
    await child.started;
    const lines = Array.from({ length: 13 }, (_, i) => `/src/File${i}.m:${i + 1}:1: error: broken ${i}`);
    child.stdout.emit('data', `${lines.join('\n')}\n** BUILD FAILED **\n`);
    child.emit('close', 65, null);
    const result = await promise;
    assert(!result.ok);
    expect(result.diagnostics.length).toBe(10);
    expect(result.truncated).toBe(3);
    expect(writer.records.filter((r) => r.level === 'error').length).toBe(10);
  });

  test('an unresolvable scheme fails as STIM_NO_SCHEME before anything is spawned', async () => {
    const child = fakeChild();
    const spawnCalls = harness(tmp, { child, listing: '{"project":{"name":"App","schemes":["one","two"]}}' });
    const result = await buildIos({ root: tmp, iosDir: join(tmp, 'ios'), udid: 'u', logWriter: recordingWriter() });
    assert(!result.ok);
    expect(result.code).toBe('STIM_NO_SCHEME');
    expect(spawnCalls).toEqual([]);
  });

  test('an asynchronous spawn error resolves the build instead of hanging it', async () => {
    const child = fakeChild();
    harness(tmp, { child });
    const promise = buildIos({
      root: tmp,
      iosDir: join(tmp, 'ios'),
      udid: 'u',
      logWriter: recordingWriter(),
      derivedDataPath: join(tmp, 'dd'),
    });
    await child.started;
    child.emit('error', new Error('spawn xcodebuild EACCES'));
    const result = await promise;
    assert(!result.ok);
    expect(result.diagnostics[0]?.message).toMatch(/EACCES/);
  });

  test('an app with no readable bundle id is a build failure, not an install failure three steps later', async () => {
    const child = fakeChild();
    harness(tmp, { child, bundleId: null });
    const dd = join(tmp, 'dd');
    makeProduct(dd);
    const promise = buildIos({
      root: tmp,
      iosDir: join(tmp, 'ios'),
      udid: 'u',
      logWriter: recordingWriter(),
      derivedDataPath: dd,
    });
    await child.started;
    child.emit('close', 0, null);
    const result = await promise;
    assert(!result.ok);
    expect(result.diagnostics[0]?.message).toMatch(/No readable CFBundleIdentifier/);
  });

  test('programmer errors throw, because they are bugs in the caller and not build outcomes', async () => {
    const writer = recordingWriter();
    await expect(() => buildIos({ udid: 'u', logWriter: writer } as unknown as BuildIosArgs)).rejects.toThrow(
      TypeError,
    );
    await expect(() => buildIos({ root: tmp, udid: 'u' } as unknown as BuildIosArgs)).rejects.toThrow(TypeError);
    await expect(() =>
      buildIos({ root: tmp, iosDir: join(tmp, 'ios'), udid: 'u', logWriter: {} as unknown as NdjsonWriter }),
    ).rejects.toThrow(TypeError);
    await expect(() => buildIos({ root: tmp, iosDir: join(tmp, 'ios'), logWriter: writer })).rejects.toThrow(TypeError);
  });
});

describe('buildXcode with explicit project inputs', () => {
  test.each([true, false])(
    'resolves only the selected project application when a scheme builds several apps (present: %s)',
    async (present) => {
      const project = { flag: '-workspace', path: join(tmp, 'Native.xcworkspace'), dir: tmp, name: 'Native' };
      const selectedProject = join(tmp, 'Native.xcodeproj');
      const otherProject = join(tmp, 'Other.xcodeproj');
      mkdirSync(selectedProject);
      mkdirSync(otherProject);
      const selectedApp = join(tmp, 'products', 'Selected.app');
      const otherApp = join(tmp, 'products', 'Other.app');
      mkdirSync(selectedApp, { recursive: true });
      mkdirSync(otherApp);
      const product = (projectPath: string, name: string) => ({
        buildSettings: {
          TARGET_NAME: 'Native',
          PROJECT_FILE_PATH: projectPath,
          PRODUCT_TYPE: 'com.apple.product-type.application',
          PLATFORM_NAME: 'iphonesimulator',
          TARGET_BUILD_DIR: join(tmp, 'products'),
          FULL_PRODUCT_NAME: name,
        },
      });
      const child = fakeChild();
      const promise = buildXcode({
        root: tmp,
        project,
        scheme: 'Native',
        applicationTarget: { name: 'Native', projectPath: selectedProject },
        compilationCache: [],
        udid: 'owned-simulator',
        derivedDataPath: join(tmp, 'derived'),
        logWriter: recordingWriter(),
        exec: makeExecutor({
          runFile(file, args = []) {
            if (file === 'xcodebuild' && args.includes('-list')) return '{"workspace":{"schemes":["Native"]}}';
            if (file === 'xcodebuild' && args.includes('-showBuildSettings'))
              return JSON.stringify([
                product(otherProject, 'Other.app'),
                ...(present ? [product(selectedProject, 'Selected.app')] : []),
              ]);
            if (file === 'plutil') return '{"CFBundleIdentifier":"org.example.selected"}';
            throw new Error(`unexpected tool ${file}`);
          },
          spawn: () => {
            child.start();
            return child as unknown as ChildProcess;
          },
        }),
      });
      await child.started;
      child.emit('close', 0, null);
      const result = await promise;
      expect(result).toMatchObject(present ? { ok: true } : { ok: false, code: 'STIM_BUILD_FAILED' });
      expect('appPath' in result ? result.appPath : null).toBe(present ? selectedApp : null);
    },
  );
});
