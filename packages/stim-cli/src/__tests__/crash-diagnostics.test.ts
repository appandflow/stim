import { afterEach, expect, test } from 'vitest';
import { createServer, type Server } from 'node:http';
import { symbolicateErrors } from '../error-symbolication.ts';
import { errorDiagnostics, mergeErrorCopies } from '../error-diagnostics.ts';
import { captureNativeCrashes, parseAndroidCrashes, parseIosCrash } from '../native-crash.ts';
import { verifyLaunch } from '../engine/app-install.ts';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetExecutor, setExecutor } from '../exec.ts';
import { launchErrorPreview } from '../launch-error-preview.ts';
import { buildCriteria, recordMatches } from '../logs-query.ts';

let server: Server | undefined;
afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

test('symbolication preserves stack association, normalizes text columns and leaves raw records unchanged', async () => {
  let posted: unknown;
  server = createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    posted = JSON.parse(text);
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        stack: [
          { file: '/app/src/crash.ts', lineNumber: 7, column: 4 },
          { file: '/app/app/_layout.tsx', lineNumber: 12, column: 2 },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const raw = [
    {
      src: 'device',
      msg: 'Error: broken\n    at fail (http://10.0.2.2:8083/index.bundle?platform=android:100:8)',
      componentStack: '    at Screen (http://10.0.2.2:8083/index.bundle?platform=android:200:3)',
    },
  ];
  const original = JSON.stringify(raw);
  const result = await symbolicateErrors(raw, { port });
  expect(posted).toEqual({
    stack: [
      {
        file: 'http://10.0.2.2:8083/index.bundle?platform=android',
        lineNumber: 100,
        column: 7,
        methodName: '<unknown>',
      },
      {
        file: 'http://10.0.2.2:8083/index.bundle?platform=android',
        lineNumber: 200,
        column: 2,
        methodName: '<unknown>',
      },
    ],
  });
  expect(result[0]?.msg).toContain('/app/src/crash.ts:7:5');
  expect(result[0]?.componentStack).toContain('/app/app/_layout.tsx:12:3');
  expect(JSON.stringify(raw)).toBe(original);
});

test('a failed or mismatched symbolication response keeps the captured stack readable', async () => {
  const raw = [{ msg: 'Error: broken\n    at fail (http://localhost:8083/index.bundle:100:8)' }];
  server = createServer((_req, res) => res.end(JSON.stringify({ stack: [] })));
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const result = await symbolicateErrors(raw, { port });
  expect(result[0]?.msg).toBe(raw[0]?.msg);
  expect(result[0]?.symbolicationNote).toContain('invalid Metro response');
  expect((await symbolicateErrors(raw, { port: null }))[0]?.symbolicationNote).toContain('no verified Metro');
});

test('app frames beyond a framework prefix survive both preview limits without reversing the call chain', () => {
  const frames = [
    ...Array.from({ length: 11 }, (_, i) => `    at react${i} (/app/node_modules/react/index.js:${i + 1}:2)`),
    '    at View (/app/src/View.tsx:4:3)',
    '    at RootLayout(./_layout.tsx) (http://localhost:8082/index.bundle:22:3)',
  ];
  const record = { msg: 'Error: failed', stack: frames.join('\n'), componentStack: frames.join('\n') };
  const lines = launchErrorPreview([record], '/app');
  expect(lines.filter((line) => line.startsWith('  at '))).toHaveLength(20);
  expect(lines.filter((line) => line.includes('View (src/View.tsx:4:3)'))).toHaveLength(2);
  expect(lines.filter((line) => line.includes('3 more frames (3 dependency/native)'))).toHaveLength(2);
  expect(lines.indexOf('  at View (src/View.tsx:4:3)')).toBeGreaterThan(
    lines.indexOf('  at react0 (node_modules/react/index.js:1:2)'),
  );
});

test('cross-source copies collapse only with matching title, location, platform and time', () => {
  const a = { ts: 1000, src: 'client', platform: 'ios', msg: 'Error: broken\n    at render (app.tsx:4:2)' };
  const b = { ...a, ts: 1100, src: 'device' };
  expect(mergeErrorCopies([a, b])).toHaveLength(1);
  expect(mergeErrorCopies([a, b, { ...a, ts: 1200 }])).toHaveLength(2);
  expect(mergeErrorCopies([a, b])[0]?.mirroredSources).toEqual(['client', 'device']);
  for (const other of [
    { ...b, platform: 'android' },
    { ...b, ts: 2500 },
    { ...b, src: 'client' },
    { ...b, msg: 'Error: broken\n    at other (app.tsx:8:2)' },
  ]) {
    expect(mergeErrorCopies([a, other])).toHaveLength(2);
  }
});

test('iOS reports cannot leak another simulator, app or previous launch into the crash summary', () => {
  const body = {
    captureTime: '2025-01-02T00:00:01Z',
    coalitionName: 'com.apple.CoreSimulator.SimDevice.own',
    bundleInfo: { CFBundleIdentifier: 'app.test' },
    incident: 'incident',
    exception: { type: 'EXC_BAD_ACCESS', signal: 'SIGSEGV' },
    threads: [
      {
        triggered: true,
        frames: [{ imageIndex: 0, symbol: 'crashHere', imageOffset: 42, sourceFile: 'App.swift', sourceLine: 17 }],
      },
    ],
    usedImages: [{ name: 'TestApp' }],
  };
  const text = '{}\n' + JSON.stringify(body);
  const target = {
    platform: 'ios' as const,
    deviceId: 'own',
    appId: 'app.test',
    since: Date.parse('2025-01-02T00:00:00Z'),
  };
  expect(parseIosCrash(text, target)?.record.stack).toEqual([{ file: 'App.swift', line: 17, fn: 'crashHere' }]);
  expect(parseIosCrash(text, { ...target, deviceId: 'other' })).toBeNull();
  expect(parseIosCrash(text, { ...target, appId: 'other' })).toBeNull();
  expect(parseIosCrash(text, { ...target, since: target.since + 2000 })).toBeNull();
});

test('Android crash buffer retains the exception from a dead app but not another process or old crash', () => {
  const text = [
    '1000.000 E/AndroidRuntime( 44): FATAL EXCEPTION: main',
    '1000.001 E/AndroidRuntime( 44): Process: app.test, PID: 44',
    '1000.002 E/AndroidRuntime( 44): java.lang.IllegalStateException: native failure',
    '1000.003 E/AndroidRuntime( 44):     at app.test.MainActivity.onCreate(MainActivity.kt:10)',
    '1001.000 E/AndroidRuntime( 45): FATAL EXCEPTION: main',
    '1001.001 E/AndroidRuntime( 45): Process: other.app, PID: 45',
  ].join('\n');
  const target = { platform: 'android' as const, deviceId: 'emulator-5554', appId: 'app.test', since: 1000000 };
  const records = parseAndroidCrashes(text, target, 100);
  expect(records).toHaveLength(1);
  expect(records[0]?.msg).toContain('MainActivity.kt:10');
  expect(records[0]?.deviceTs).toBe(1000000);
  expect(parseAndroidCrashes(text, target, 150)[0]?.deviceTs).toBe(records[0]?.deviceTs);
  expect(records[0]?.msg).not.toContain('other.app');
  expect(parseAndroidCrashes(text, { ...target, since: 2000000 }, 100)).toEqual([]);
  expect(recordMatches(records[0], buildCriteria({ errorsOnly: true }))).toBe(true);
  expect(recordMatches({ ...records[0], event: undefined }, buildCriteria({ errorsOnly: true }))).toBe(false);
  expect(recordMatches(records[0], buildCriteria({ errorsOnly: true, sources: ['metro'] }))).toBe(false);
});

test('a native crash before any Metro request ends verification without calling the app healthy or merely unverified', async () => {
  let time = 1000;
  const crash = {
    ts: 1500,
    src: 'device',
    platform: 'ios',
    level: 'fatal',
    event: 'native_crash',
    msg: 'App.swift:17: Fatal error: broken',
  };
  const result = await verifyLaunch({
    since: 1000,
    platform: 'ios',
    readRecords: () => [],
    readDeviceRecords: () => [],
    readClientRecords: () => [],
    readNativeCrashes: () => [crash],
    processAlive: () => false,
    now: () => time,
    sleep: async (ms) => {
      time += ms;
    },
  });
  expect(result).toMatchObject({ fatal: true, verified: false, processAlive: false, errors: [crash] });
  expect(result.waitedMs).toBeLessThan(2000);
});

test('an unavailable process probe or unrelated crash does not invent a native launch failure', async () => {
  for (const alive of [null, false]) {
    let time = 1000;
    const result = await verifyLaunch({
      since: 1000,
      platform: 'ios',
      timeoutMs: 2500,
      readRecords: () => [],
      readDeviceRecords: () => [],
      readClientRecords: () => [],
      readNativeCrashes: () => [{ ts: 1500, platform: 'android', event: 'native_crash', level: 'fatal' }],
      processAlive: () => alive,
      now: () => time,
      sleep: async (ms) => {
        time += ms;
      },
    });
    expect(result.fatal).not.toBe(true);
    expect(result.verified).toBe(false);
  }
});

test('Android crash evidence is fatal even while its PID remains behind a system crash dialog', async () => {
  let time = 1000;
  const crash = {
    ts: 1500,
    src: 'device',
    platform: 'android',
    level: 'fatal',
    event: 'native_crash',
    msg: 'FATAL EXCEPTION: main',
  };
  const result = await verifyLaunch({
    since: 1000,
    platform: 'android',
    readRecords: () => [],
    readDeviceRecords: () => [],
    readClientRecords: () => [],
    readNativeCrashes: () => [crash],
    processAlive: () => true,
    now: () => time,
    sleep: async (ms) => {
      time += ms;
    },
  });
  expect(result).toMatchObject({ fatal: true, verified: false, processAlive: true, errors: [crash] });
  expect(result.waitedMs).toBeLessThan(2000);
});

test('structured Metro frames retain zero-based columns, including the first column', async () => {
  let posted: unknown;
  server = createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    posted = JSON.parse(text);
    res.end(JSON.stringify({ stack: [{ file: '/app/source.ts', lineNumber: 5, column: 0 }] }));
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const [record] = await symbolicateErrors(
    [{ stack: [{ file: 'http://localhost:8083/index.bundle', line: 1, column: 0, fn: 'start' }] }],
    { port },
  );
  expect(posted).toMatchObject({ stack: [{ column: 0 }] });
  expect(record?.stack).toEqual([{ file: '/app/source.ts', line: 5, column: 0, fn: 'start' }]);
});

test('a stalled symbolication server cannot hide or indefinitely delay the original error', async () => {
  server = createServer(() => {});
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const raw = { msg: 'Error: failed\n at render (http://localhost:8083/index.bundle:1:1)' };
  const [record] = await symbolicateErrors([raw], { port, timeoutMs: 30 });
  expect(record?.msg).toBe(raw.msg);
  expect(record?.symbolicationNote).toContain('timed out');
});

test('APK frames require a matching ELF build ID and repeated collection does not duplicate a crash', () => {
  const root = mkdtempSync(join(tmpdir(), 'stim-native-diagnostics-'));
  const priorSdk = process.env.ANDROID_HOME;
  process.env.STIM_HOME = join(root, 'stim-home');
  process.env.ANDROID_HOME = join(root, 'sdk');
  const tools = join(root, 'sdk/ndk/27/toolchains/llvm/prebuilt/host/bin');
  const libraries = join(root, 'android/app/src/main/jniLibs/arm64-v8a');
  const logs = join(process.env.STIM_HOME, 'logs');
  const epoch = Math.floor(Date.now() / 1000);
  const raw = [
    `${epoch}.000 F/DEBUG( 80): *** *** *** ***`,
    `${epoch}.001 F/DEBUG( 80): pid: 44, tid: 44, name: app.test  >>> app.test <<<`,
    `${epoch}.002 F/DEBUG( 80): signal 6 (SIGABRT), code -1`,
    `${epoch}.003 F/DEBUG( 80): #00 pc 000046bc /data/app/base.apk (offset 0x8534000) (BuildId: abc123)`,
  ].join('\n');
  try {
    mkdirSync(tools, { recursive: true });
    mkdirSync(libraries, { recursive: true });
    writeFileSync(join(tools, 'llvm-symbolizer'), '');
    writeFileSync(join(libraries, 'libapp.so'), '');
    let matches = true;
    let symbolRequests = 0;
    const requestedAddresses: string[] = [];
    setExecutor({
      runFile: () => String(Date.now()),
      runFileQuiet: (file, args) => {
        if (file === 'adb') return raw;
        if (file.endsWith('llvm-readelf')) return `Build ID: ${matches ? 'abc123' : 'def456'}`;
        if (file.endsWith('llvm-symbolizer')) {
          symbolRequests++;
          requestedAddresses.push(args.at(-1));
          return `crashHere\n${root}/app.cpp:17:4`;
        }
        return null;
      },
    });
    const target = {
      root,
      platform: 'android' as const,
      appId: 'app.test',
      deviceId: 'owned',
      since: epoch * 1000 - 1000,
    };
    const [first] = captureNativeCrashes(target, logs);
    expect(first?.stack).toEqual([{ fn: 'crashHere', file: `${root}/app.cpp`, line: 17, column: 4 }]);
    expect(requestedAddresses).toEqual(['0x000046bc']);
    captureNativeCrashes(target, logs);
    expect(readdirSync(logs).filter((name) => name.endsWith('.ndjson'))).toHaveLength(1);
    expect(readdirSync(logs).some((name) => name.endsWith('.tmp'))).toBe(false);
    expect(JSON.parse(readFileSync(join(logs, readdirSync(logs)[0]!), 'utf8')).rawReport).toContain('base.apk');
    const priorRequests = symbolRequests;
    matches = false;
    const [mismatch] = captureNativeCrashes(target, logs);
    expect(symbolRequests).toBe(priorRequests);
    expect(mismatch?.stack).toMatchObject([{ file: 'base.apk' }]);
    expect(mismatch?.symbolicationNote).toContain('partial');
  } finally {
    resetExecutor();
    if (priorSdk === undefined) delete process.env.ANDROID_HOME;
    else process.env.ANDROID_HOME = priorSdk;
    delete process.env.STIM_HOME;
    rmSync(root, { recursive: true, force: true });
  }
});

test('human error queries include correlated component context without admitting an unrelated device error', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stim-error-context-'));
  process.env.STIM_HOME = root;
  try {
    const primary = { src: 'metro', ts: 1000, level: 'error', msg: 'Error: broken', stack: 'at render (app.tsx:4:2)' };
    const related = {
      src: 'device',
      ts: 1100,
      level: 'error',
      msg: 'Error: broken',
      componentStack: 'at Screen (app.tsx:4:2)',
    };
    const unrelated = { ...related, ts: 1150, componentStack: 'at Other (other.tsx:2:3)' };
    writeFileSync(join(root, 'device.ndjson'), [related, unrelated].map((record) => JSON.stringify(record)).join('\n'));
    const result = await errorDiagnostics([primary], { root, logsDir: root, port: null });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ stack: primary.stack, componentStack: related.componentStack });
    expect(JSON.stringify(result)).not.toContain('other.tsx');
  } finally {
    delete process.env.STIM_HOME;
    rmSync(root, { recursive: true, force: true });
  }
});

test('split Android error-object lines remain associated with their own error and are not printed twice', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stim-split-error-'));
  process.env.STIM_HOME = root;
  try {
    const header = {
      src: 'device',
      ts: 1000,
      proc: 'ReactNativeJS(44)',
      platform: 'android',
      level: 'error',
      msg: '{ [Error: broken]',
    };
    const component = { ...header, ts: 1001, msg: "  componentStack: '\\n    at Screen (app.tsx:4:2)" };
    const metadata = { ...header, ts: 1001, msg: '  isComponentError: true }' };
    const other = {
      ...component,
      ts: 1002,
      proc: 'ReactNativeJS(55)',
      msg: "  componentStack: '\\n    at Wrong (other.tsx:5:2)',",
    };
    const records = [header, component, metadata, other];
    writeFileSync(join(root, 'device.ndjson'), records.map((record) => JSON.stringify(record)).join('\n'));
    const result = await errorDiagnostics(records, { root, logsDir: root, port: null });
    expect(result).toHaveLength(2);
    expect(result[0]?.msg).toContain('Screen (app.tsx:4:2)');
    expect(result[0]?.msg).not.toContain('Wrong');
    expect(result[1]?.msg).toContain('Wrong');
    const preview = launchErrorPreview(result, root).join('\n');
    expect(preview).toContain('Component stack:');
    expect(preview).toContain('at Screen (app.tsx:4:2)');
    expect(preview).not.toContain('isComponentError: true');
    expect(preview).toContain('captured stack text is incomplete');
  } finally {
    delete process.env.STIM_HOME;
    rmSync(root, { recursive: true, force: true });
  }
});
