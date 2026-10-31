import { afterEach, expect, test } from 'vitest';
import { createServer, type Server } from 'node:http';
import { symbolicateErrors } from '../diagnostics/error-symbolication.ts';
import { errorDiagnostics, mergeErrorCopies } from '../diagnostics/error-diagnostics.ts';
import {
  bundleBindFailure,
  captureNativeCrashes,
  captureWorkspaceCrashes,
  parseAndroidCrashes,
  parseIosCrash,
} from '../diagnostics/native-crash.ts';
import { verifyLaunch } from '../engine/launch-verify.ts';
import { type NdjsonRecord } from '../ndjson.ts';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import type { ChildProcess } from 'node:child_process';
import { launchErrorPreview } from '../diagnostics/launch-error-preview.ts';
import { recordFromLine } from '../supervisor/server-expo.ts';
import { clearWorkspaceStateKeys, writeWorkspaceState } from '../workspace/workspace-state.ts';
import { upsertProject } from '../workspace/config.ts';
import { deviceLeasePath, fileLeaseIo } from '../engine/device-lease.ts';
import { writeDiagnosticOnceAsync } from '../diagnostics/diagnostic-store.ts';

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

test('native previews remove metadata noise but full output preserves it and Java causes stay distinct', () => {
  const record = {
    event: 'native_crash',
    msg: 'Native crash',
    stack: [
      { file: 'libc.so', fn: '(abort+156) (BuildId: abc123) [captured native frame]' },
      {
        file: 'Trailhead.debug.dylib',
        fn: '@objc AppDelegate.application (in Trailhead.debug.dylib) (/<compiler-generated>:0)',
      },
    ],
  };
  const preview = launchErrorPreview([record]).join('\n');
  expect(preview).toContain('at (abort+156) (libc.so)');
  expect(preview).toContain('at @objc AppDelegate.application (Trailhead.debug.dylib; compiler-generated)');
  expect(preview).not.toContain('BuildId');
  const full = launchErrorPreview([record], undefined, { full: true }).join('\n');
  expect(full).toContain('BuildId: abc123');
  expect(full).toContain('[captured native frame]');
  const java = launchErrorPreview([
    {
      msg: 'RuntimeException: failed\n  at wrapper (Runtime.java:5)\nCaused by: IllegalStateException: broken\n  at crash (MainApplication.kt:34)',
    },
  ]).join('\n');
  expect(java).toContain('Error stack:\n  at wrapper');
  expect(java).toContain('Caused-by stack:\n  at crash');
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
  expect(parseIosCrash(text, { ...target, until: target.since + 500 })).toBeNull();
});

test('only a symbol one part of the app needs from another part of the same app marks the stored build as unlaunchable', () => {
  const bundle = '/Users/USER/Library/Developer/CoreSimulator/Devices/D/data/Containers/Bundle/Application/A/Stim.app';
  const crash = (termination: object) => {
    const body = {
      captureTime: '2025-01-02T00:00:01Z',
      coalitionName: 'com.apple.CoreSimulator.SimDevice.own',
      bundleInfo: { CFBundleIdentifier: 'app.test' },
      incident: 'incident',
      exception: { type: 'EXC_CRASH', signal: 'SIGABRT' },
      termination,
    };
    const target = {
      platform: 'ios' as const,
      deviceId: 'own',
      appId: 'app.test',
      since: Date.parse('2025-01-02T00:00:00Z'),
    };
    return parseIosCrash('{}\n' + JSON.stringify(body), target)?.record ?? {};
  };
  const symbol = '__ZN8facebook6hermes3cdp11CDPDebugAPI17addConsoleMessageENS1_14ConsoleMessageE';

  expect(
    bundleBindFailure(
      crash({
        namespace: 'DYLD',
        indicator: 'Symbol missing',
        reasons: [
          `Symbol not found: ${symbol}`,
          `Referenced from: <0D5DABD8-59B5-36C0-B957-475A4985ECC3> ${bundle}/Frameworks/React.framework/React`,
          `Expected in:     <22A8186E-E00E-32BB-A9FF-082E90BAEA6F> ${bundle}/Frameworks/hermesvm.framework/hermesvm`,
        ],
      }),
    ),
  ).toBe(symbol);

  for (const termination of [
    {
      namespace: 'DYLD',
      indicator: 'Symbol missing',
      reasons: [
        'Symbol not found: _objc_claimAutoreleasedReturnValue',
        `Referenced from: <0D5DABD8-59B5-36C0-B957-475A4985ECC3> ${bundle}/Frameworks/React.framework/React`,
        'Expected in:     <22A8186E-E00E-32BB-A9FF-082E90BAEA6F> /usr/lib/libobjc.A.dylib',
      ],
    },
    {
      namespace: 'DYLD',
      indicator: 'Symbol missing',
      reasons: [
        'Symbol not found: _foo',
        `Referenced from: <0D5DABD8-59B5-36C0-B957-475A4985ECC3> ${bundle}/Frameworks/React.framework/React`,
        'Expected in:     <22A8186E-E00E-32BB-A9FF-082E90BAEA6F> /Users/USER/Other/Plugin.app/Contents/Plugin',
      ],
    },
    {
      namespace: 'DYLD',
      indicator: 'Library missing',
      reasons: [
        'Library not loaded: /usr/lib/libSystem.B.dylib',
        `Referenced from: <FBFA434E-83F1-3D72-B54D-578931412E61> ${bundle}/Stim`,
      ],
    },
    { namespace: 'SIGNAL', indicator: 'Abort trap: 6' },
  ])
    expect(bundleBindFailure(crash(termination))).toBeNull();
});

test('a DebugServerException previews the Metro error it carries instead of the JSON body', () => {
  const root = '/app/root';
  const frame =
    "\\u001b[0m\\u001b[31m\\u001b[1m>\\u001b[22m\\u001b[39m\\u001b[90m 1 |\\u001b[39m \\u001b[36mimport\\u001b[39m \\u001b[32m'./stim-582-missing'\\u001b[39m\\u001b[33m;\\u001b[39m\\n \\u001b[90m   |\\u001b[39m         \\u001b[31m\\u001b[1m^\\u001b[22m\\u001b[39m\\u001b[0m";
  const body =
    '{"type":"UnableToResolveError","originModulePath":"/app/root/app/_layout.tsx","targetModuleName":"./stim-582-missing",' +
    '"message":"Unable to resolve module ./stim-582-missing from /app/root/app/_layout.tsx: \\n\\nNone of these files exist:\\n  * app/stim-582-missing(.android.ts|.native.ts|.ts|.tsx)\\n  * app/stim-582-missing\\n' +
    frame +
    '","cause":{"candidates":{"file":{"type":"sourceFile","filePathPrefix":"app/stim-582-missing","candidateExts":["",".android.ts",".ts"]}},' +
    '"_expoImportStack":"Import stack:\\n\\n app/_layout.tsx\\n | import \\"./stim-582-missing\\"\\n\\n app (require.context)\\n","name":"Error",' +
    '"message":"The module could not be resolved because none of these files exist:\\n\\n  * /app/root/app/stim-582-missing",' +
    '"stack":"Error: The module could not be resolved\\n    at resolve (/app/root/node_modules/metro-resolver/src/resolve.js:53:13)\\n    at resolveRequest (/app/root/node_modules/@expo/cli/build/src/start/server/metro/withMetroResolvers.js:75:32)"},' +
    '"name":"Error","stack":"Error: Unable to resolve module ./stim-582-missing\\n    at ModuleResolver.resolveDependency (/app/root/node_modules/metro/src/node-haste/DependencyGraph/ModuleResolution.js:143:15)",' +
    '"errors":[{"description":"Unable to resolve module ./stim-582-missing from /app/root/app/_layout.tsx"}]}';
  const split = body.indexOf('withMetroResolvers.js') + 8;
  const text = [
    '1000.000 E/AndroidRuntime( 44): FATAL EXCEPTION: main',
    '1000.001 E/AndroidRuntime( 44): Process: app.test, PID: 44',
    '1000.002 E/AndroidRuntime( 44): com.facebook.react.common.DebugServerException: The development server returned response error code: 500',
    '1000.002 E/AndroidRuntime( 44): URL: http://10.0.2.2:8082/index.bundle?platform=android&dev=true',
    '1000.002 E/AndroidRuntime( 44): Body:',
    `1000.002 E/AndroidRuntime( 44): ${body.slice(0, split)}`,
    `1000.002 E/AndroidRuntime( 44): ${body.slice(split)}`,
    '1000.003 E/AndroidRuntime( 44): \tat com.facebook.react.devsupport.BundleDownloader.processBundleResult(BundleDownloader.kt:305)',
    '1000.003 E/AndroidRuntime( 44): \tat okhttp3.internal.connection.RealCall$AsyncCall.run(RealCall.kt:519)',
  ].join('\n');
  const target = { platform: 'android' as const, deviceId: 'emulator-5554', appId: 'app.test', since: 1000000 };
  const [record] = parseAndroidCrashes(text, target, 0);
  expect(record).toBeDefined();
  const preview = launchErrorPreview([record!], root).join('\n');
  expect(preview.match(/DebugServerException: The development server returned response error code: 500/g)).toHaveLength(
    1,
  );
  expect(preview).toContain('UnableToResolveError: Unable to resolve module ./stim-582-missing from app/_layout.tsx:');
  expect(preview).toContain("> 1 | import './stim-582-missing';");
  expect(preview).toContain('Import stack:\n app/_layout.tsx\n | import "./stim-582-missing"');
  expect(preview).toContain('[Metro error body compacted; full text in stim logs]');
  expect(preview).toContain(
    'at com.facebook.react.devsupport.BundleDownloader.processBundleResult(BundleDownloader.kt:305)',
  );
  expect(preview).not.toContain('\u001b');
  expect(preview).not.toContain('originModulePath');
  expect(preview).not.toContain('candidateExts');
  expect(preview).not.toContain('metro-resolver');
  expect(preview).not.toContain('Error stack:\n  at resolve');
  const full = launchErrorPreview([record!], root, { full: true }).join('\n');
  expect(full).toContain('"originModulePath":"/app/root/app/_layout.tsx"');
  expect(full).not.toContain('Metro error body compacted');
  const metroFirst = launchErrorPreview(
    [
      {
        src: 'metro',
        event: 'bundling_error',
        msg: 'Unable to resolve module ./stim-582-missing from /app/root/app/_layout.tsx: \n\nNone of these files exist:\n  * app/stim-582-missing',
      },
      record!,
    ],
    root,
  ).join('\n');
  expect(metroFirst).not.toContain('(diagnosis above)');
  expect(metroFirst).toContain("> 1 | import './stim-582-missing';");
  expect(metroFirst).toContain('Import stack:\n app/_layout.tsx\n | import "./stim-582-missing"');
  const completeDiagnosis = JSON.parse(body);
  const completeMetroFirst = launchErrorPreview(
    [
      {
        src: 'metro',
        event: 'bundling_error',
        msg: completeDiagnosis.message,
        codeFrame: completeDiagnosis.cause['_expoImportStack'],
      },
      record!,
    ],
    root,
  ).join('\n');
  expect(completeMetroFirst).toContain(
    'UnableToResolveError: Unable to resolve module ./stim-582-missing from app/_layout.tsx: (diagnosis above)',
  );
  expect(completeMetroFirst.match(/None of these files exist/g)).toHaveLength(1);
  expect(completeMetroFirst.match(/Import stack:/g)).toHaveLength(1);
  const mentioned = launchErrorPreview(
    [
      { src: 'client', msg: 'assertion: expected "Unable to resolve module ./stim-582-missing from app/_layout.tsx:"' },
      record!,
    ],
    root,
  ).join('\n');
  expect(mentioned).toContain("> 1 | import './stim-582-missing';");
  expect(mentioned).not.toContain('(diagnosis above)');

  const rebuild = (variant: string, at: number) =>
    parseAndroidCrashes(
      text.replace(body.slice(0, split), variant.slice(0, at)).replace(body.slice(split), variant.slice(at)),
      target,
      0,
    )[0]!;
  const splitPreview = launchErrorPreview([rebuild(body, body.indexOf('\\n    at ModuleResolver') + 2)], root).join(
    '\n',
  );
  expect(splitPreview).toContain(
    'UnableToResolveError: Unable to resolve module ./stim-582-missing from app/_layout.tsx:',
  );
  expect(splitPreview).not.toContain('ModuleResolution.js');
  expect(splitPreview).toContain(
    'at com.facebook.react.devsupport.BundleDownloader.processBundleResult(BundleDownloader.kt:305)',
  );

  const stackKey = body.replace('None of these files exist:', 'const options = { stack: \\"first\\\\nsecond\\" };');
  const stackKeyPreview = launchErrorPreview([rebuild(stackKey, split)], root).join('\n');
  expect(stackKeyPreview).toContain('const options = { stack: "first\\nsecond" };');
  expect(stackKeyPreview).not.toContain('Error stack:\nfirst');

  const appJson = launchErrorPreview(
    [
      {
        src: 'device',
        platform: 'android',
        proc: 'ReactNativeJS(44)',
        msg: 'API failed: {"type":"HttpError","message":"Unauthorized","status":401}',
      },
    ],
    root,
  ).join('\n');
  expect(appJson).toContain('API failed: {"type":"HttpError","message":"Unauthorized","status":401}');
  expect(appJson).not.toContain('compacted');
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
  expect(result.waitedMs).toBeLessThan(3000);
});

function yieldingClock(start = 1000) {
  let time = start;
  return {
    at: () => time,
    now: () => time,
    sleep: async (ms: number) => {
      time += ms;
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
  };
}

const verifyWithProbeInVerifyingIteration = (
  readNativeCrashes: () => Promise<NdjsonRecord[]>,
  processAlive: () => boolean = () => true,
) => {
  const clock = yieldingClock();
  return verifyLaunch({
    since: 1000,
    platform: 'ios',
    stabilityMs: 900,
    readRecords: () => [{ ts: 1100, src: 'metro', platform: 'ios', event: 'bundle_build_done' }],
    readDeviceRecords: () => [],
    readClientRecords: () => [],
    readNativeCrashes,
    processAlive,
    now: clock.now,
    sleep: clock.sleep,
  });
};

test('an app that exits while the launch waits for a running crash probe is not reported as verified', async () => {
  let exited = false;
  const result = await verifyWithProbeInVerifyingIteration(
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      exited = true;
      return [];
    },
    () => !exited,
  );
  expect(result).toMatchObject({ fatal: true, verified: false, processAlive: false });
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

test('APK frames require a matching ELF build ID and repeated collection does not duplicate a crash', async () => {
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
      runFileQuiet: (file, args) => {
        if (args.includes('date')) return String(Date.now());
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
    const [first] = await captureNativeCrashes(target, logs);
    expect(first?.stack).toEqual([{ fn: 'crashHere', file: `${root}/app.cpp`, line: 17, column: 4 }]);
    expect(requestedAddresses).toEqual(['0x000046bc']);
    await captureNativeCrashes(target, logs);
    expect(readdirSync(logs).filter((name) => name.endsWith('.ndjson'))).toHaveLength(1);
    expect(readdirSync(logs).some((name) => name.endsWith('.tmp'))).toBe(false);
    expect(JSON.parse(readFileSync(join(logs, readdirSync(logs)[0]!), 'utf8')).rawReport).toContain('base.apk');
    const priorRequests = symbolRequests;
    matches = false;
    const [mismatch] = await captureNativeCrashes(target, logs);
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
    expect(preview).not.toContain('captured stack text is incomplete');
    const full = launchErrorPreview(result, root, { full: true }).join('\n');
    expect(full).toContain('at Screen (app.tsx:4:2)');
    expect(full).not.toContain('captured stack text is incomplete');
  } finally {
    delete process.env.STIM_HOME;
    rmSync(root, { recursive: true, force: true });
  }
});

test('historical Expo errors keep their original coordinates after bundle activity on either Expo log path', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stim-expo-rebuild-'));
  process.env.STIM_HOME = root;
  const original = {
    ts: 1000,
    src: 'device',
    platform: 'android',
    msg: 'Error: broken\n at fail (http://localhost:8083/index.bundle:10:2)',
  };
  try {
    const events = [
      { ...recordFromLine('Android Bundling 20%'), ts: 1100 },
      { ...recordFromLine('Android Bundled 50ms', { stream: 'stderr' }), ts: 1100 },
      recordFromLine(
        'stim-bundle-response: ' +
          JSON.stringify({
            src: 'metro',
            event: 'bundle_response_started',
            platform: 'android',
            requestId: 'next',
            ts: 1100,
          }),
        { stream: 'stderr' },
      ),
    ];
    for (const event of events) {
      writeFileSync(join(root, 'metro.ndjson'), JSON.stringify(event) + '\n');
      const [record] = await errorDiagnostics([original], { root, logsDir: root, port: 8083, allowRequest: true });
      expect(record?.msg).toBe(original.msg);
      expect(record?.symbolicationNote).toContain('Metro rebuilt after this error');
    }
    writeFileSync(join(root, 'metro.ndjson'), JSON.stringify({ ...events[2], platform: 'ios' }) + '\n');
    const [otherPlatform] = await errorDiagnostics([original], { root, logsDir: root, port: null });
    expect(otherPlatform?.symbolicationNote).toBeUndefined();
  } finally {
    delete process.env.STIM_HOME;
    rmSync(root, { recursive: true, force: true });
  }
});

test('live native collection requires the current launch and device claim, not a historical launch marker', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stim-crash-claim-'));
  process.env.STIM_HOME = join(root, 'home');
  const logs = join(root, 'logs');
  const since = Date.now() - 5000;
  const launch = {
    appId: 'app.test',
    deviceId: 'emulator-5556',
    metroPort: null,
    release: true,
    launchedAt: new Date(since).toISOString(),
  };
  let reads = 0;
  let avd = 'stim-own';
  const marker = {
    event: 'launch_attempt',
    platform: 'android',
    ts: since,
    appId: launch.appId,
    deviceId: launch.deviceId,
  };
  const raw = [
    `${Math.floor((since + 1000) / 1000)}.000 E/AndroidRuntime( 44): FATAL EXCEPTION: main`,
    `${Math.floor((since + 1000) / 1000)}.001 E/AndroidRuntime( 44): Process: app.test, PID: 44`,
    `${Math.floor((since + 1000) / 1000)}.002 E/AndroidRuntime( 44): java.lang.IllegalStateException: failed`,
  ].join('\n');
  try {
    mkdirSync(logs);
    writeFileSync(join(logs, 'launch.ndjson'), JSON.stringify(marker) + '\n');
    writeWorkspaceState(root, { launches: { android: launch } });
    upsertProject(root, { platforms: { android: { owned: true, avdName: 'stim-own' } } });
    setExecutor({
      runFileQuiet: (_file, args) => {
        if (args.includes('date')) return String(Date.now());
        if (args.includes('emu')) return avd + '\nOK';
        reads++;
        return raw;
      },
    });
    expect(await captureWorkspaceCrashes(root, logs, [marker])).toEqual([]);
    expect(reads).toBe(1);
    expect(readdirSync(logs).filter((name) => name.startsWith('native-crash-'))).toHaveLength(1);
    clearWorkspaceStateKeys(root, ['launches']);
    await captureWorkspaceCrashes(root, logs);
    expect(reads).toBe(1);
    writeWorkspaceState(root, { launches: { android: launch } });
    avd = 'stim-other-workspace';
    await captureWorkspaceCrashes(root, logs);
    expect(reads).toBe(1);
    writeFileSync(join(logs, 'launch.ndjson'), JSON.stringify({ ...marker, physical: true }) + '\n');
    clearWorkspaceStateKeys(root, ['launches']);
    fileLeaseIo.writeHolder(root, { android: { id: launch.deviceId, token: 'own-token', kind: 'declared' } });
    const lease = {
      version: 1,
      platform: 'android',
      id: launch.deviceId,
      holder: root,
      token: 'own-token',
      grantedAt: new Date(since - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 10000).toISOString(),
    };
    fileLeaseIo.writeLease(deviceLeasePath('android', launch.deviceId), JSON.stringify(lease));
    await captureWorkspaceCrashes(root, logs);
    expect(reads).toBe(2);
    fileLeaseIo.writeLease(
      deviceLeasePath('android', launch.deviceId),
      JSON.stringify({ ...lease, token: 'new-token', holder: root + '-other' }),
    );
    await captureWorkspaceCrashes(root, logs);
    expect(reads).toBe(2);
    expect(
      parseAndroidCrashes(
        raw,
        { platform: 'android', appId: launch.appId, deviceId: launch.deviceId, since, until: since + 1 },
        0,
      ),
    ).toEqual([]);
  } finally {
    resetExecutor();
    delete process.env.STIM_HOME;
    rmSync(root, { recursive: true, force: true });
  }
});

test('cancelling crash capture stops its pending tool and rejects without writing diagnostics', async () => {
  const logs = mkdtempSync(join(tmpdir(), 'stim-crash-cancel-'));
  const controller = new AbortController();
  const reason = new Error('cancel crash capture');
  const executor = getExecutor();
  let child: ChildProcess | undefined;
  setExecutor({
    runFileQuietAsync: (_file, _args, options) =>
      executor.runFileQuietAsync(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], {
        ...options,
        cwd: logs,
        onSpawn(spawned) {
          child = spawned;
          options.onSpawn?.(spawned);
          setTimeout(() => controller.abort(reason), 10);
        },
      }),
  });
  try {
    await expect(
      captureNativeCrashes(
        { platform: 'android', deviceId: 'owned', appId: 'app.test', since: 0 },
        logs,
        controller.signal,
      ),
    ).rejects.toBe(reason);
    expect(child?.signalCode).toBe('SIGKILL');
    expect(readdirSync(logs)).toEqual([]);
  } finally {
    resetExecutor();
    rmSync(logs, { recursive: true, force: true });
  }
});

test('concurrent async diagnostic publications keep one complete snapshot and clean their temporary files', async () => {
  const logs = mkdtempSync(join(tmpdir(), 'stim-diagnostic-publish-'));
  const path = join(logs, 'native-crash.ndjson');
  const snapshots = ['first\n'.repeat(10000), 'second\n'.repeat(10000)];
  try {
    await Promise.all(snapshots.map((content) => writeDiagnosticOnceAsync(path, content)));
    expect(snapshots).toContain(readFileSync(path, 'utf8'));
    expect(readdirSync(logs)).toEqual(['native-crash.ndjson']);
  } finally {
    rmSync(logs, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== 'darwin')('iOS crash reports come from the operation environment home', async () => {
  const home = mkdtempSync(join(tmpdir(), 'stim-crash-client-home-'));
  const reports = join(home, 'Library/Logs/DiagnosticReports');
  const logs = join(home, 'logs');
  const since = Date.now() - 1000;
  const report = {
    captureTime: new Date().toISOString(),
    coalitionName: 'com.apple.CoreSimulator.SimDevice.owned',
    bundleInfo: { CFBundleIdentifier: 'app.test' },
    incident: 'client-report',
    exception: { type: 'EXC_CRASH', signal: 'SIGABRT' },
  };
  mkdirSync(reports, { recursive: true });
  writeFileSync(join(reports, 'client.ips'), '{}\n' + JSON.stringify(report));
  setExecutor({ runFileQuiet: () => null });
  try {
    const records = await captureNativeCrashes(
      { platform: 'ios', deviceId: 'owned', appId: 'app.test', since },
      logs,
      undefined,
      { HOME: home },
    );
    expect(records.map((record) => record.incident)).toEqual(['client-report']);
  } finally {
    resetExecutor();
    rmSync(home, { recursive: true, force: true });
  }
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
