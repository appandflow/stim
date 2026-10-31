import assert from 'node:assert';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { androidHome } from '../devices/android.ts';
import type { NdjsonRecord, NdjsonWriter } from '../ndjson.ts';
import {
  apkOutputsDir,
  buildAndroid as buildAndroidImpl,
  gradlewPath,
  productFlavorRefusal,
} from '../integrations/react-native-build.ts';
import { BUILD_ERROR, buildGradle, locateApk as locateProjectApk, parseProductFlavors } from '../engine/gradle.ts';
import { makeChildProcess, makeWriter } from './_factories.ts';
import { defaultAndroidLayout } from '../workspace/settings.ts';

function locateApk(root: string, transcript = '', variant: string | null = null) {
  return locateProjectApk(
    { directory: join(root, 'android'), outputsDir: apkOutputsDir(defaultAndroidLayout(root)) },
    transcript,
    variant,
  );
}

let root: string;
let sdk: string;
let savedAndroidHome: string | undefined;

const buildAndroid = (
  request: Omit<Parameters<typeof buildAndroidImpl>[0], 'layout'> & {
    layout?: Parameters<typeof buildAndroidImpl>[0]['layout'];
  },
  options?: Parameters<typeof buildAndroidImpl>[1],
) => buildAndroidImpl({ layout: defaultAndroidLayout(request.root), ...request }, { platform: 'linux', ...options });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stim-gradle-'));
  sdk = join(root, 'fake-sdk');
  mkdirSync(sdk, { recursive: true });
  savedAndroidHome = process.env.ANDROID_HOME;
  process.env.ANDROID_HOME = sdk;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  if (savedAndroidHome === undefined) delete process.env.ANDROID_HOME;
  else process.env.ANDROID_HOME = savedAndroidHome;
});

function makeAndroidProject({ gradlew = true } = {}) {
  mkdirSync(join(root, 'android'), { recursive: true });
  if (gradlew) {
    const path = gradlewPath(defaultAndroidLayout(root));
    writeFileSync(path, '#!/bin/sh\nexit 0\n');
    chmodSync(path, 0o755);
  }
}

function writeApk(name = 'app-debug.apk', contents = 'apk') {
  const dir = join(apkOutputsDir(defaultAndroidLayout(root)), 'debug');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), contents);
  return join(dir, name);
}

function writeFlavoredApk(flavor: string, buildType: string, name: string, contents = 'apk') {
  const dir = join(apkOutputsDir(defaultAndroidLayout(root)), flavor, buildType);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), contents);
  return join(dir, name);
}

describe('locateApk', () => {
  test('a transcript path that does not exist does not win', () => {
    const apk = writeApk('app-debug.apk');
    expect(locateApk(root, 'Wrote APK to /nope/gone.apk').apkPath).toBe(apk);
  });

  test('exactly one flavored debug APK is used, with a note naming the directory and the variant to set', () => {
    const apk = writeFlavoredApk('production', 'debug', 'app-production-debug.apk');
    const result = locateApk(root, '');
    expect(result.apkPath).toBe(apk);
    expect(result.note).toContain(join('apk', 'production', 'debug'));
    expect(result.note).toMatch(/android\.variant/);
    expect(result.note).toMatch(/"productionDebug"/);
  });

  test('the recursive fallback never picks an intermediate or an androidTest APK', () => {
    writeFlavoredApk('production', 'debug', 'app-production-debug-unsigned.apk');
    mkdirSync(join(apkOutputsDir(defaultAndroidLayout(root)), 'androidTest', 'production', 'debug'), {
      recursive: true,
    });
    writeFileSync(
      join(
        apkOutputsDir(defaultAndroidLayout(root)),
        'androidTest',
        'production',
        'debug',
        'app-production-debug-androidTest.apk',
      ),
      'apk',
    );
    expect(locateApk(root, '')).toEqual({ apkPath: null });
  });
});

function fakeChild({
  lines = [],
  stderrLines = [],
  code = 0,
  signal = null,
  error = null,
  onExit = null,
}: {
  lines?: string[];
  stderrLines?: string[];
  code?: number | null;
  signal?: NodeJS.Signals | null;
  error?: Error | null;
  onExit?: (() => void) | null;
} = {}): ChildProcess {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter & { setEncoding: (enc?: string) => void };
    stderr: EventEmitter & { setEncoding: (enc?: string) => void };
  };
  child.stdout = new EventEmitter() as EventEmitter & { setEncoding: (enc?: string) => void };
  child.stderr = new EventEmitter() as EventEmitter & { setEncoding: (enc?: string) => void };
  child.stdout.setEncoding = () => {};
  child.stderr.setEncoding = () => {};
  setImmediate(() => {
    for (const line of lines) child.stdout.emit('data', `${line}\n`);
    for (const line of stderrLines) child.stderr.emit('data', `${line}\n`);
    if (error) {
      child.emit('error', error);
      child.emit('close', null, null);
      return;
    }
    if (onExit) onExit();
    child.emit('exit', code, signal);
    child.emit('close', code, signal);
  });
  return child as unknown as ChildProcess;
}

function recordingWriter(): NdjsonWriter & { records: NdjsonRecord[] } {
  const records: NdjsonRecord[] = [];
  const writer = makeWriter({
    write(record) {
      records.push(record as NdjsonRecord);
      return true;
    },
  });
  return Object.assign(writer, { records });
}

const nativeScript = join(import.meta.dirname, '../../shim/android-optimizations.gradle');

describe('buildAndroid', () => {
  test('refuses a Windows native build with an object path that cannot fit before invoking Gradle', async () => {
    const longRoot = join(root, 'windows-object-path-limit'.padEnd(60, '-'));
    mkdirSync(join(longRoot, 'android'), { recursive: true });
    writeFileSync(gradlewPath(defaultAndroidLayout(longRoot)), '');
    let spawned = false;
    const result = await buildAndroid(
      { root: longRoot, abi: 'x86_64' },
      {
        platform: 'win32',
        spawnFn: () => {
          spawned = true;
          return fakeChild();
        },
      },
    );
    expect(result).toMatchObject({ ok: false, code: 'STIM_PATH_TOO_LONG', durationMs: 0 });
    expect(spawned).toBe(false);
  });

  test('forwards the target ABI to Gradle and records it in the full argv', async () => {
    makeAndroidProject();
    const writer = recordingWriter();
    const calls: string[][] = [];
    await buildAndroid(
      { root, logWriter: writer, abi: 'arm64-v8a' },
      {
        spawnFn: (_cmd, args) => {
          calls.push(args);
          return fakeChild({ lines: ['BUILD SUCCESSFUL in 1s'], onExit: () => writeApk() });
        },
      },
    );
    expect(calls).toEqual([
      ['assembleDebug', '--build-cache', '-PreactNativeArchitectures=arm64-v8a', '--init-script', nativeScript],
    ]);
    const starts = writer.records.filter((r) => r.event === 'build_start');
    expect(starts.length).toBe(1);
    const start = starts[0];
    assert(start);
    expect(start.src).toBe('build');
    expect(start.level).toBe('info');
    expect(start.raw).toBe(undefined);
    expect(start.msg).toBe(
      `${gradlewPath(defaultAndroidLayout(root))} assembleDebug --build-cache -PreactNativeArchitectures=arm64-v8a --init-script ${nativeScript}`,
    );
  });

  test('the build_start record shows --no-build-cache when the cache is off', async () => {
    makeAndroidProject();
    const writer = recordingWriter();
    await buildAndroid(
      { root, logWriter: writer },
      {
        buildCache: false,
        spawnFn: () => fakeChild({ lines: ['BUILD SUCCESSFUL in 1s'], onExit: () => writeApk() }),
      },
    );
    const start = writer.records.find((r) => r.event === 'build_start');
    assert(start);
    expect(start.msg).toBe(
      `${gradlewPath(defaultAndroidLayout(root))} assembleDebug --no-build-cache --init-script ${nativeScript}`,
    );
  });

  test('a failing build comes back as data with the diagnostics extracted, never a throw', async () => {
    makeAndroidProject();
    const transcript = readFileSync(join(import.meta.dirname, 'fixtures', 'gradle-compile-failure.txt'), 'utf-8').split(
      '\n',
    );
    const writer = recordingWriter();
    const result = await buildAndroid(
      { root, logWriter: writer },
      {
        spawnFn: () => fakeChild({ lines: transcript, code: 1 }),
        now: (() => {
          let t = 0;
          return () => (t += 2000);
        })(),
      },
    );

    assert(!result.ok);
    expect(result.code).toBe(BUILD_ERROR);
    expect(result.reason).toMatch(/exit code 1/);
    expect(result.durationMs).toBe(2000);
    assert(result.diagnostics);
    expect(result.diagnostics.length > 0).toBeTruthy();
    expect(result.diagnostics.some((d) => (d.file || '').endsWith('Broken.java'))).toBeTruthy();
    expect(result.truncated).toBe(0);
    expect(result.lastLines.length > 0).toBeTruthy();
    expect(result.lastLines.every((l) => typeof l === 'string')).toBeTruthy();
  });

  test('exit 0 with no APK is a failure, not a success with nothing to install', async () => {
    makeAndroidProject();
    const result = await buildAndroid(
      { root, logWriter: recordingWriter() },
      {
        spawnFn: () => fakeChild({ lines: ['BUILD SUCCESSFUL in 3s'] }),
      },
    );
    assert(!result.ok);
    expect(result.reason).toMatch(/produced no APK/);
    expect(result.remedy).toMatch(/assembleDebug/);
  });

  test('a variant drives assemble<Variant> and the APK is read from the flavor directory', async () => {
    makeAndroidProject();
    const calls: string[][] = [];
    const result = await buildAndroid(
      { root, logWriter: recordingWriter(), variant: 'productionDebug' },
      {
        spawnFn: (_cmd, args) => {
          calls.push(args);
          return fakeChild({
            lines: ['BUILD SUCCESSFUL in 8m14s'],
            onExit: () => writeFlavoredApk('production', 'debug', 'app-production-debug.apk'),
          });
        },
      },
    );
    expect(calls).toEqual([['assembleProductionDebug', '--build-cache', '--init-script', nativeScript]]);
    assert(result.ok);
    expect(result.apkPath).toBe(
      join(apkOutputsDir(defaultAndroidLayout(root)), 'production', 'debug', 'app-production-debug.apk'),
    );
  });

  test('two flavored debug APKs and no variant is a refusal listing them, never a guess', async () => {
    makeAndroidProject();
    writeFlavoredApk('preview', 'debug', 'app-preview-debug.apk');
    const result = await buildAndroid(
      { root, logWriter: recordingWriter() },
      {
        spawnFn: () =>
          fakeChild({
            lines: ['BUILD SUCCESSFUL in 8m14s'],
            onExit: () => writeFlavoredApk('production', 'debug', 'app-production-debug.apk'),
          }),
      },
    );
    assert(!result.ok);
    expect(result.code).toBe(BUILD_ERROR);
    expect(result.reason).toMatch(/2 debug APKs/);
    expect(result.remedy).toMatch(/android\.variant/);
    expect(result.lastLines.some((l) => l.includes('app-preview-debug.apk'))).toBeTruthy();
    expect(result.lastLines.some((l) => l.includes('app-production-debug.apk'))).toBeTruthy();
  });

  test('an UP-TO-DATE variant build installs the APK gradle left in place, whatever its mtime (#154)', async () => {
    makeAndroidProject();
    const apk = writeFlavoredApk('preview', 'debug', 'app-preview-debug.apk');
    const old = (Date.now() - 3_600_000) / 1000;
    utimesSync(apk, old, old);
    const result = await buildAndroid(
      { root, logWriter: recordingWriter(), variant: 'previewDebug' },
      {
        spawnFn: () =>
          fakeChild({
            lines: ['BUILD SUCCESSFUL in 13s', '1055 actionable tasks: 78 executed, 977 up-to-date'],
          }),
      },
    );
    assert(result.ok);
    expect(result.apkPath).toBe(apk);
  });

  test('a spawn that errors after starting still resolves', async () => {
    makeAndroidProject();
    const result = await buildAndroid(
      { root, logWriter: recordingWriter() },
      {
        spawnFn: () => fakeChild({ lines: ['starting'], error: new Error('boom') }),
      },
    );
    assert(!result.ok);
    expect(result.reason).toMatch(/boom/);
    expect(result.lastLines).toEqual(['starting']);
  });

  test('a missing android/ is reported before anything is spawned', async () => {
    let spawned = false;
    const result = await buildAndroid(
      { root, logWriter: recordingWriter() },
      {
        spawnFn: () => {
          spawned = true;
          return fakeChild();
        },
      },
    );
    expect(spawned).toBe(false);
    assert(!result.ok);
    expect(result.remedy).toMatch(/prebuild/);
    expect(result.diagnostics).toEqual([]);
  });

  test('without an SDK variable, the SDK is where Android Studio installs it on this host', () => {
    const platform = process.platform;
    const env = { HOME: '/home/dev', USERPROFILE: 'C:\\Users\\dev', LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local' };
    try {
      for (const [host, expected] of [
        ['darwin', join('/home/dev', 'Library', 'Android', 'sdk')],
        ['linux', join('/home/dev', 'Android', 'Sdk')],
        ['win32', join(env.LOCALAPPDATA, 'Android', 'Sdk')],
      ] as const) {
        Object.defineProperty(process, 'platform', { value: host });
        expect(androidHome(env)).toBe(expected);
      }
    } finally {
      Object.defineProperty(process, 'platform', { value: platform });
    }
  });

  test('a slow gradle build emits heartbeats carrying the latest transcript line', async () => {
    makeAndroidProject();
    const beats: string[] = [];
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter & { setEncoding: (enc?: string) => void };
      stderr: EventEmitter & { setEncoding: (enc?: string) => void };
    };
    child.stdout = new EventEmitter() as EventEmitter & { setEncoding: (enc?: string) => void };
    child.stderr = new EventEmitter() as EventEmitter & { setEncoding: (enc?: string) => void };
    child.stdout.setEncoding = () => {};
    child.stderr.setEncoding = () => {};
    const promise = buildAndroid(
      { root, logWriter: recordingWriter() },
      {
        spawnFn: () => child as unknown as ChildProcess,
        heartbeatMs: 10,
        onHeartbeat: (line) => beats.push(line),
      },
    );
    child.stdout.emit('data', '> Task :app:compileDebugKotlin\n');
    await new Promise((r) => setTimeout(r, 80));
    expect(beats.length).toBeGreaterThanOrEqual(1);
    expect(beats[0]).toMatch(/^ {2}build {6} still compiling \(\d+s\)$/);
    writeApk();
    child.emit('exit', 0, null);
    child.emit('close', 0, null);
    const result = await promise;
    assert(result.ok);
    const settled = beats.length;
    await new Promise((r) => setTimeout(r, 40));
    expect(beats.length).toBe(settled);
  });

  test.skipIf(process.platform !== 'win32')(
    'waits for the Java client pipes after its batch launcher exits',
    async () => {
      makeAndroidProject();
      const child = makeChildProcess();
      let finished = false;
      const work = buildAndroid({ root, logWriter: recordingWriter() }, { spawnFn: () => child, heartbeatMs: 0 }).then(
        (result) => {
          finished = true;
          return result;
        },
      );
      child.emit('exit', 1, null);
      await new Promise((resolve) => setImmediate(resolve));
      expect(finished).toBe(false);
      child.stdout?.emit('data', 'Java client finished\n');
      child.emit('close', 1, null);
      expect((await work).lastLines).toContain('Java client finished');
    },
  );

  test.each([0, 1])('keeps fresh ccache statistics on success or failure (exit: %s)', async (exitCode) => {
    makeAndroidProject();
    const statsLog = join(root, 'logs', 'ccache-stats.log');
    mkdirSync(join(root, 'logs'), { recursive: true });
    writeFileSync(statsLog, 'stale run\ncache_miss\n');
    const notes: string[] = [];
    const envs: NodeJS.ProcessEnv[] = [];
    const result = await buildAndroid(
      { root, logWriter: recordingWriter() },
      {
        ccache: {
          dir: join(root, 'ccache'),
          statsLog,
          env: { CMAKE_CXX_COMPILER_LAUNCHER: '/opt/homebrew/bin/ccache', CCACHE_DIR: join(root, 'ccache') },
        },
        spawnFn: (_cmd, args, opts) => {
          expect(args.slice(0, 3)).toEqual(['assembleDebug', '--build-cache', '--init-script']);
          expect(args).toHaveLength(4);
          expect(args[3]).toBe(nativeScript);
          expect(existsSync(args[3]!)).toBe(true);
          envs.push(opts.env as NodeJS.ProcessEnv);
          expect(existsSync(statsLog)).toBe(false);
          return fakeChild({
            code: exitCode,
            onExit: () => {
              writeFileSync(statsLog, ['# a.cpp', 'direct_cache_hit', '# b.cpp', 'cache_miss'].join('\n'));
              writeApk();
            },
          });
        },
        onNote: (line) => notes.push(line),
      },
    );
    expect(result.ok).toBe(exitCode === 0);
    const spawnEnv = envs[0];
    assert(spawnEnv);
    expect(spawnEnv.CMAKE_CXX_COMPILER_LAUNCHER).toBe('/opt/homebrew/bin/ccache');
    expect(spawnEnv.CCACHE_DIR).toBe(join(root, 'ccache'));
    expect(spawnEnv.STIM_ANDROID_CCACHE).toBe('on');
    expect(spawnEnv.STIM_ANDROID_PCH).toBe('auto');
    expect(spawnEnv.STIM_ANDROID_NATIVE_PROFILE).toMatch(/^[a-f0-9]{16}$/);
    expect(spawnEnv.TERM).toBe('dumb');
    expect(result.ccache).toEqual({ status: 'reported', hits: 1, misses: 1, hitRatePercent: 50 });
    expect(notes.some((line) => line.includes('PCH off by default'))).toBe(true);
  });

  test('CAS injects its toolchain instead of the ccache PCH policy and clears inherited launchers', async () => {
    makeAndroidProject();
    const script = join(import.meta.dirname, '../../shim/android-cas.gradle');
    const result = await buildAndroid(
      { root },
      {
        env: { CMAKE_CXX_COMPILER_LAUNCHER: '/old/ccache', ANDROID_HOME: sdk },
        cas: {
          id: 'apple-cas-test',
          dir: join(root, 'cas'),
          initScript: script,
          env: { CMAKE_CXX_COMPILER_LAUNCHER: '', STIM_ANDROID_CAS_CONTEXT: join(root, 'context.json') },
        },
        spawnFn: (_cmd, args, opts) => {
          expect(args).toEqual([
            'assembleDebug',
            '--build-cache',
            '--init-script',
            script,
            '--init-script',
            nativeScript,
          ]);
          expect((opts.env as NodeJS.ProcessEnv).CMAKE_CXX_COMPILER_LAUNCHER).toBe('');
          expect((opts.env as NodeJS.ProcessEnv).STIM_ANDROID_CCACHE).toBe('off');
          expect((opts.env as NodeJS.ProcessEnv).STIM_ANDROID_PCH).toBe('auto');
          expect((opts.env as NodeJS.ProcessEnv).STIM_ANDROID_CAS_CONTEXT).toBe(join(root, 'context.json'));
          return fakeChild({ lines: ['BUILD SUCCESSFUL in 1s'], onExit: () => writeApk() });
        },
      },
    );
    assert(result.ok);
    expect(result.ccache?.status).toBe('unavailable');
  });

  test('without ccache the project compiler is preserved and no statistics are claimed', async () => {
    makeAndroidProject();
    const calls: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
    const result = await buildAndroid(
      { root, logWriter: recordingWriter() },
      {
        spawnFn: (_cmd, args, opts) => {
          calls.push({ args, env: opts.env as NodeJS.ProcessEnv });
          return fakeChild({ lines: ['BUILD SUCCESSFUL in 1s'], onExit: () => writeApk() });
        },
      },
    );
    assert(result.ok);
    const call = calls[0];
    assert(call);
    expect(call.args).toEqual(['assembleDebug', '--build-cache', '--init-script', nativeScript]);
    expect(call.env.CMAKE_CXX_COMPILER_LAUNCHER).toBe(undefined);
    expect(call.env.CCACHE_DIR).toBe(undefined);
    expect(result.ccache).toEqual({ status: 'unavailable', hits: null, misses: null, hitRatePercent: null });
  });
});

const COMMENTED_GRADLE = `android {
    // productFlavors {
    //     staging { }
    // }
    /* the flavors this project used to ship:
    productFlavors {
        legacy { }
    }
    */
    productFlavors {
        production { } // the store build
        preview { }
    }
}
`;

const DIMENSIONED_GRADLE = `android {
    flavorDimensions "tier", "store"
    productFlavors {
        free { dimension "tier" }
        paid { dimension "tier" }
        play { dimension "store" }
        amazon { dimension "store" }
    }
}
`;

describe('parseProductFlavors', () => {
  test('commented-out blocks are ignored and the real block is read', () => {
    expect(parseProductFlavors(COMMENTED_GRADLE)).toEqual({ known: true, dimensions: [['production', 'preview']] });
  });
});

describe('productFlavorRefusal', () => {
  test('every dimension combination is named', () => {
    const refusal = productFlavorRefusal({ flavors: parseProductFlavors(DIMENSIONED_GRADLE), variant: null });
    assert(refusal);
    expect(refusal.remedy).toMatch(/freePlayDebug, freeAmazonDebug, paidPlayDebug, paidAmazonDebug/);
  });
});

describe('a real flavored build.gradle', () => {
  const TLON_GRADLE = `android {
    flavorDimensions "profile"
    productFlavors {
        production {
            dimension "profile"
            applicationId "io.tlon.groups"
        }
        preview {
            dimension "profile"
            applicationId "io.tlon.groups.preview"
        }
    }
}
`;

  test('flavors that name different dimensions with no declared order are unknown', () => {
    const text = TLON_GRADLE.replace('    flavorDimensions "profile"\n', '').replace(
      'dimension "profile"\n            applicationId "io.tlon.groups.preview"',
      'dimension "store"\n            applicationId "io.tlon.groups.preview"',
    );
    expect(parseProductFlavors(text)).toEqual({ known: false, dimensions: [] });
  });
});

describe('buildGradle with explicit project inputs', () => {
  function projectAtRoot() {
    return {
      directory: root,
      gradlew: join(root, 'gradlew'),
      module: ':mobile',
      outputsDir: join(root, 'products', 'apk'),
    };
  }

  test('relative transcript output resolves against the supplied Gradle directory', async () => {
    const project = projectAtRoot();
    const apk = join(root, 'custom-mobile.apk');
    writeFileSync(apk, 'selected module');
    const result = await buildGradle(
      { root, project, task: ':mobile:assembleDebug' },
      { spawnFn: () => fakeChild({ lines: ['Wrote APK to custom-mobile.apk'] }) },
    );
    assert(result.ok);
    expect(result.apkPath).toBe(apk);
  });

  test.each([null, 'stagingDebug'])(
    'missing selected output refuses rather than falling back to android/app (%s)',
    async (variant) => {
      const project = projectAtRoot();
      writeApk();
      writeFlavoredApk('staging', 'debug', 'app-staging-debug.apk');
      const result = await buildGradle(
        { root, project, task: ':mobile:assembleDebug', variant },
        { spawnFn: () => fakeChild({ lines: ['BUILD SUCCESSFUL'] }) },
      );
      assert(!result.ok);
      expect(result.reason).toContain(project.outputsDir);
      expect(result.remedy).toContain(variant ? ':mobile:tasks' : ':mobile:assembleDebug');
      expect(result.remedy).not.toContain(':mobile::mobile');
      expect(result.remedy).not.toContain(':app');
      expect(result).not.toHaveProperty('apkPath');
    },
  );

  test('missing SDK points at the supplied local.properties and refuses before spawning', async () => {
    const result = await buildGradle(
      { root, project: projectAtRoot(), task: ':mobile:assembleDebug' },
      {
        env: { ANDROID_HOME: join(root, 'absent-sdk') },
        spawnFn: () => {
          throw new Error('SDK refusal must not spawn');
        },
      },
    );
    assert(!result.ok);
    expect(result.remedy).toContain('into local.properties');
    expect(result.remedy).not.toContain('android/local.properties');
  });
});
