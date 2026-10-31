import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecOptions, Executor } from '../exec.ts';
import type { NdjsonRecord } from '../ndjson.ts';
import { isBundleActivityLine } from '../supervisor/server-expo.ts';
import {
  LAUNCH_ERROR,
  devClientUrl,
  androidAppProcess,
  androidDevClientUrl,
  debugHttpHostScript,
  deviceShellArg,
  installIosApp,
  launchAndroidReleaseApp,
  launchAndroidApp,
  launchIosApp,
  parseLaunchedPid,
  ensureMetroReverse,
  clearOtherUserApps,
} from '../engine/app-install.ts';
import {
  MANIFEST_GRACE_MS,
  VERIFY_TIMEOUT_MS,
  isBundleProof,
  isBundleRequestProof,
  unverifiedLaunchLines,
  verifyLaunch,
  verifyAndroidReleaseLaunch,
  verifyReleaseLaunch,
} from '../engine/launch-verify.ts';

type LaunchResult = {
  ok?: boolean;
  failed?: boolean;
  code?: string;
  reason?: string;
  mode?: string;
  component?: string;
  devClientUrl?: string;
  devClientNote?: string | null;
  reversed?: string[];
  debugHttpHost?: string | null;
  debugHttpHostNote?: string | null;
  [key: string]: unknown;
};

interface RecordingExec extends Executor {
  calls: string[][];
  options: Parameters<Executor['runFile']>[2][];
}
function asyncMock(exec: Partial<Executor>): Executor {
  return {
    ...exec,
    runFileAsync: async (file: string, args: string[], opts: ExecOptions) => {
      if (!exec.runFile) throw new Error('the mock has no runFile');
      return exec.runFile(file, args, opts);
    },
  } as Executor;
}

function recordingExec({
  fail = null,
  failCode,
  failStderr = 'device not booted',
  outputs = {},
}: {
  fail?: string | string[] | null;
  failCode?: string;
  failStderr?: string;
  outputs?: Record<string, string | string[]>;
} = {}): RecordingExec {
  const calls: string[][] = [];
  const options: Parameters<Executor['runFile']>[2][] = [];
  const outputReads = new Map<string, number>();
  return {
    calls,
    options,
    runFile(file: string, args: string[] = [], opts) {
      calls.push([file, ...args]);
      options.push(opts);
      const key = [file, ...args].join(' ');
      if (fail && [fail].flat().some((match) => key.includes(match))) {
        const err = new Error(`Command failed: ${key}`);
        (err as Error & { stderr?: string }).stderr = failStderr;
        if (failCode) (err as NodeJS.ErrnoException).code = failCode;
        throw err;
      }
      for (const [match, value] of Object.entries(outputs)) {
        if (key.includes(match)) {
          if (typeof value === 'string') return value;
          const index = outputReads.get(match) ?? 0;
          outputReads.set(match, index + 1);
          return value[index] ?? value.at(-1) ?? '';
        }
      }
      return '';
    },
    run() {
      throw new Error('app-install must use runFile, not the shell');
    },
    runQuiet() {
      throw new Error('app-install must use runFile, not the shell');
    },
    runFileQuiet() {
      throw new Error('app-install must use runFile, not runFileQuiet');
    },
    async runFileAsync(file: string, args: string[] = [], opts) {
      return this.runFile(file, args, opts);
    },
    runFileQuietAsync() {
      throw new Error('app-install must use runFile, not runFileQuietAsync');
    },
    spawn() {
      throw new Error('app-install does not spawn');
    },
    findExecutable: () => null,
  };
}

describe('ios', () => {
  test('clearOtherUserApps removes every user app except the workspace app and XCUITest runners', async () => {
    const removed: string[] = [];
    expect(
      await clearOtherUserApps(
        { udid: 'U1', keep: 'com.example.keep' },
        {
          list: async () => [
            'com.example.old',
            'com.example.keep',
            'com.callstack.agentdevice.runner.uitests.xctrunner',
            'com.example.other',
          ],
          uninstall: async (_udid, bundleId) => {
            removed.push(bundleId);
          },
        },
      ),
    ).toEqual({ listed: true, kept: true, removed: ['com.example.old', 'com.example.other'], failed: [] });
    expect(removed).toEqual(['com.example.old', 'com.example.other']);
  });

  test('installIosApp times the artifact step separately from dev-client preparation', async () => {
    const exec = recordingExec();
    const times = [0, 500, 1300];
    const appPath = '/tmp/My App.app';
    const result = await installIosApp(
      {
        udid: 'U1',
        appPath,
        bundleId: 'com.example.app',
        devClientScheme: 'myapp',
      },
      {
        exec,
        now: () => {
          const time = times.shift();
          assert(time !== undefined);
          return time;
        },
      },
    );
    expect(result).toEqual({
      ok: true,
      appPath,
      artifactDurationMs: 500,
      devClientPreparationDurationMs: 800,
      schemeApprovals: [
        'com.apple.CoreSimulator.CoreSimulatorBridge-->com.example.app=com.example.app',
        'com.apple.CoreSimulator.CoreSimulatorBridge-->myapp=com.example.app',
      ],
    });
  });

  test('a running Expo dev client restarts with its project URL instead of an openurl into the old process', async () => {
    const exec = recordingExec({
      outputs: {
        'launchctl list': '4242\t0\tUIKitApplication:com.example.app[abcd][rb-legacy]\n',
        'simctl launch': 'com.example.app: 5151',
      },
    });
    const result = await launchIosApp(
      {
        udid: 'U1',
        bundleId: 'com.example.app',
        metroPort: 8082,
        devClientScheme: 'myapp',
        consolePaths: { stdout: '/container/trace.out', stderr: '/container/trace.err' },
      },
      { exec },
    );
    expect(result).toMatchObject({ ok: true, mode: 'launch', pid: 5151, restartedPid: 4242 });
    expect(exec.calls.map((call) => call[2])).toEqual(['spawn', 'spawn', 'launch']);
    expect(exec.calls.at(-1)).toContain('--terminate-running-process');
    expect(exec.calls.at(-1)).toContain('--initialUrl');
  });

  test('a failed terminate refuses an openurl into the old process', async () => {
    const exec = recordingExec({
      fail: 'simctl terminate',
      outputs: { 'launchctl list': '4242\t0\tUIKitApplication:com.example.app[abcd][rb-legacy]\n' },
    });
    const result = await launchIosApp(
      { udid: 'U1', bundleId: 'com.example.app', metroPort: 8082, devClientScheme: 'myapp' },
      { exec },
    );
    expect(result.code).toBe(LAUNCH_ERROR);
    expect(result.reason).toMatch(/simctl terminate com\.example\.app failed.*pid 4242/);
    expect(exec.calls.some((call) => call.includes('openurl'))).toBe(false);
  });

  test('an unreadable process list launches with simctl terminating any running copy, not a separate terminate', async () => {
    const exec = recordingExec({ fail: ['launchctl list', 'simctl terminate'], failCode: 'ETIMEDOUT' });
    const result = await launchIosApp({ udid: 'U1', bundleId: 'com.example.app', metroPort: 8082 }, { exec });
    expect(result.ok).toBe(true);
    expect(result.restartedPid).toBeUndefined();
    expect(exec.calls.map((call) => call[2])).toEqual(['spawn', 'spawn', 'launch']);
    expect(exec.calls.at(-1)).toEqual([
      'xcrun',
      'simctl',
      'launch',
      '--terminate-running-process',
      'U1',
      'com.example.app',
    ]);
  });

  test('a failed defaults write stops the launch rather than launching unwired', async () => {
    const exec = recordingExec({ fail: 'defaults write' });
    const result = await launchIosApp({ udid: 'U1', bundleId: 'com.example.app', metroPort: 8082 }, { exec });
    expect(result.code).toBe(LAUNCH_ERROR);
    expect(result.reason).toMatch(/RCT_jsLocation/);
    expect(exec.calls.length).toBe(2);
    expect(result.reason).not.toContain('Activity Monitor');
  });

  test.each(['defaults write', 'simctl openurl', 'simctl launch'])(
    'a timed-out %s keeps the launch refusal and adds simulator recovery advice',
    async (fail) => {
      const exec = recordingExec({ fail, failCode: 'ETIMEDOUT' });
      const result = await launchIosApp(
        {
          udid: 'U1',
          bundleId: 'com.example.app',
          metroPort: 8082,
          ...(fail === 'simctl openurl' ? { devClientScheme: 'myapp' } : {}),
        },
        { exec },
      );
      expect(result.failed).toBe(true);
      expect(result.code).toBe(LAUNCH_ERROR);
      expect(result.reason).toContain('Activity Monitor');
      expect(result.reason).not.toMatch(/out of memory|OOM/i);
    },
  );

  test('a cold launch of a launcher that reads the dev-menu params passes them on its project URL', async () => {
    const exec = recordingExec({ outputs: { 'simctl launch': 'com.example.app: 4242' } });
    const result = await launchIosApp(
      {
        udid: 'U1',
        bundleId: 'com.example.app',
        metroPort: 8082,
        devClientScheme: 'myapp',
        devMenuParams: true,
        consolePaths: { stdout: '/container/trace.out', stderr: '/container/trace.err' },
      },
      { exec },
    );
    expect(exec.calls[2]?.slice(-6)).toEqual([
      '--initialUrl',
      'http://localhost:8082/?disableOnboarding=1&disableFab=1&disableAutoLaunch=1&__expo_disable_fab=1&__expo_disable_auto_launch=1',
      '-EXDevMenuShowsAtLaunch',
      '0',
      '-EXDevMenuShowFloatingActionButton',
      '0',
    ]);
    expect(result.url).toBe(devClientUrl('myapp', 8082, 'localhost', { devMenuParams: true }));
  });

  test('a cold Expo launch recovers a no-process-handle error when its app started', async () => {
    const exec = recordingExec({
      fail: 'simctl launch',
      failStderr:
        "An error was encountered processing the command (domain=NSPOSIXErrorDomain, code=3):\nApplication launch for 'com.example.app' did not return a process handle nor launch error.",
      outputs: { 'launchctl list': ['', '4242\t0\tUIKitApplication:com.example.app[abcd][rb-legacy]\n'] },
    });
    const result = await launchIosApp(
      {
        udid: 'U1',
        bundleId: 'com.example.app',
        metroPort: 8082,
        devClientScheme: 'myapp',
        consolePaths: { stdout: '/container/trace.out', stderr: '/container/trace.err' },
      },
      { exec },
    );
    expect(result).toMatchObject({ ok: true, mode: 'launch', pid: 4242 });
    expect(exec.calls.filter((call) => call.includes('launchctl'))).toHaveLength(2);
  });

  test('a no-process-handle error succeeds when the target app is running', async () => {
    const exec = recordingExec({
      fail: 'simctl launch',
      failStderr:
        "An error was encountered processing the command (domain=NSPOSIXErrorDomain, code=3):\nApplication launch for 'com.example.app' did not return a process handle nor launch error.",
      outputs: { 'launchctl list': ['', '4242\t0\tUIKitApplication:com.example.app[abcd][rb-legacy]\n'] },
    });
    const result = await launchIosApp({ udid: 'U1', bundleId: 'com.example.app', metroPort: 8082 }, { exec });
    expect(result).toEqual({ ok: true, mode: 'launch', pid: 4242, jsLocation: 'localhost:8082' });
    expect(exec.calls.at(-1)).toEqual(['xcrun', 'simctl', 'spawn', 'U1', 'launchctl', 'list']);
  });

  test('a no-process-handle error is not recovered when the process list could not be read', async () => {
    const exec = recordingExec({
      fail: 'simctl',
      failStderr:
        "An error was encountered processing the command (domain=NSPOSIXErrorDomain, code=3):\nApplication launch for 'com.example.app' did not return a process handle nor launch error.",
    });
    const result = await launchIosApp({ udid: 'U1', bundleId: 'com.example.app', metroPort: null }, { exec });
    expect(result.code).toBe(LAUNCH_ERROR);
    expect(exec.calls.filter((call) => call.includes('launchctl'))).toHaveLength(1);
  });

  test('parseLaunchedPid reads `<bundleId>: <pid>` and nothing else', async () => {
    expect(parseLaunchedPid('com.example.app: 4242')).toBe(4242);
    expect(parseLaunchedPid('com.example.app: 4242\n')).toBe(4242);
    expect(parseLaunchedPid('')).toBe(null);
    expect(parseLaunchedPid('something went wrong')).toBe(null);
    expect(parseLaunchedPid(null)).toBe(null);
    expect(parseLaunchedPid('com.example.app: 0')).toBe(null);
  });
});

describe('verifyReleaseLaunch', () => {
  test('a process that died within the window is unverified with reason exited', async () => {
    const result = await verifyReleaseLaunch({ pid: 4242, alive: () => false, sleep: async () => {} });
    expect(result.verified).toBe(false);
    expect(result.reason).toBe('exited');
  });
});

describe('android: install and launch', () => {
  test('every adb call on the launch path runs under a hard deadline', async () => {
    const exec = recordingExec({
      fail: 'android.intent.action.VIEW',
      outputs: { 'resolve-activity': ['com.example.app/.MainActivity\n', 'No activity found\n'] },
    });
    await launchAndroidApp(
      { serial: 'emulator-5554', packageName: 'com.example.app', metroPort: 8082, devClientScheme: 'myapp' },
      { exec },
    );
    await launchAndroidReleaseApp({ serial: 'emulator-5554', packageName: 'com.example.app' }, { exec });
    await androidAppProcess('emulator-5554', 'com.example.app', { exec });
    expect(exec.calls.map((call) => call.slice(3, 5).join(' '))).toEqual([
      'shell pidof',
      'shell ps',
      'reverse tcp:8082',
      'shell run-as',
      'shell am',
      'shell cmd',
      'shell am',
      'shell pidof',
      'shell ps',
      'shell cmd',
      'shell monkey',
      'shell pidof',
      'shell ps',
    ]);
    for (const options of exec.options) {
      expect(options?.timeoutMs).toBeGreaterThan(0);
      expect(options?.killSignal).toBe('SIGKILL');
    }
  });

  test('ensureMetroReverse leaves a present reverse alone and re-applies a missing one', async () => {
    const present = recordingExec({ outputs: { '--list': 'host-19 tcp:8082 tcp:8082\n' } });
    expect(await ensureMetroReverse({ serial: 'emulator-5554', metroPort: 8082 }, { exec: present })).toEqual({
      restored: false,
    });
    expect(present.calls).toEqual([['adb', '-s', 'emulator-5554', 'reverse', '--list']]);

    const missing = recordingExec({ outputs: { '--list': '' } });
    expect(await ensureMetroReverse({ serial: 'emulator-5554', metroPort: 8082 }, { exec: missing })).toEqual({
      restored: true,
    });
    expect(missing.calls.at(-1)).toEqual(['adb', '-s', 'emulator-5554', 'reverse', 'tcp:8082', 'tcp:8082']);

    const unreadable = recordingExec({ fail: '--list' });
    expect(await ensureMetroReverse({ serial: 'emulator-5554', metroPort: 8082 }, { exec: unreadable })).toMatchObject({
      failed: true,
    });
    expect(unreadable.calls).toHaveLength(1);
  });

  test('a failed force-stop refuses the launch instead of foregrounding the old process', async () => {
    const exec = recordingExec({ fail: 'force-stop', outputs: { pidof: '4242\n' } });
    const result: LaunchResult = await launchAndroidApp(
      { serial: 'emulator-5554', packageName: 'com.example.app', metroPort: 8082 },
      { exec },
    );
    expect(result.code).toBe(LAUNCH_ERROR);
    expect(result.reason).toMatch(/am force-stop com\.example\.app failed.*pid 4242/);
    expect(exec.calls.some((call) => call.includes('start'))).toBe(false);
  });

  test('an unreadable process list opens a dev client deep link with am start -S', async () => {
    const exec = recordingExec({ fail: ['pidof', 'ps -A'] });
    const result: LaunchResult = await launchAndroidApp(
      { serial: 'emulator-5554', packageName: 'com.example.app', metroPort: 8082, devClientScheme: 'myapp' },
      { exec },
    );
    expect(result).toMatchObject({ ok: true, mode: 'deep-link' });
    expect(exec.calls.at(-1)?.slice(4, 8)).toEqual(['am', 'start', '-S', '-a']);
  });

  test('an unreadable process list without a launcher activity tries a force-stop and still runs monkey', async () => {
    const exec = recordingExec({
      fail: ['pidof', 'ps -A', 'force-stop'],
      outputs: { 'resolve-activity': 'No activity found\n' },
    });
    const result: LaunchResult = await launchAndroidReleaseApp(
      { serial: 'emulator-5554', packageName: 'com.example.app' },
      { exec },
    );
    expect(result).toMatchObject({ ok: true, mode: 'monkey' });
    expect(exec.calls.slice(-2).map((call) => call.slice(4, 6))).toEqual([
      ['am', 'force-stop'],
      ['monkey', '-p'],
    ]);
  });
});

test('a failed prefs write does not fail the launch', async () => {
  const exec = asyncMock({
    runFile: (_cmd: string, args: string[]) => {
      if (args.includes('run-as')) {
        const e = new Error('run-as: package not debuggable');
        throw e;
      }
      return '';
    },
    runQuiet: () => 'com.x/.MainActivity',
  });
  const r: LaunchResult = await launchAndroidApp(
    { serial: 'emulator-5554', packageName: 'com.x', metroPort: 8082 },
    { exec },
  );
  expect(r.ok).toBe(true);
  expect(r.debugHttpHost).toBe(null);
  expect(r.debugHttpHostNote).toMatch(/relying on adb reverse/);
});

function fakeClock(start = 1000) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
    at: () => t,
  };
}

describe('isBundleProof', () => {
  test('an expo-child stdout line is the same proof by another route', async () => {
    expect(
      isBundleProof(
        { ts: 150, src: 'metro', raw: true, event: 'expo_stdout', msg: 'iOS Bundling complete 812ms' },
        100,
      ),
    ).toBe(true);
    expect(
      isBundleProof(
        { ts: 150, src: 'metro', raw: true, event: 'expo_stdout', msg: 'iOS Bundled 812ms index.js (1150 modules)' },
        100,
      ),
    ).toBe(true);
    expect(isBundleActivityLine('Android Bundling failed 91ms')).toBe(true);
    expect(isBundleProof({ ts: 150, src: 'metro', msg: 'Android Bundling failed 91ms' }, 100)).toBe(true);
    expect(isBundleProof({ ts: 150, src: 'metro', msg: 'Android Bundled 91ms' }, 100, 'ios')).toBe(false);
    expect(isBundleProof({ ts: 150, src: 'metro', msg: 'iOS Bundled 91ms' }, 100, 'ios')).toBe(true);
    expect(isBundleProof({ ts: 150, event: 'bundle_build_done', platform: 'android' }, 100, 'ios')).toBe(false);
  });
});

describe('verifyLaunch', () => {
  test('an aborted run stops waiting with STIM_CANCELLED instead of waiting out the bundle deadline', async () => {
    const controller = new AbortController();
    const waiting = verifyLaunch({
      since: Date.now(),
      timeoutMs: 60_000,
      pollMs: 10,
      readRecords: () => [],
      readDeviceRecords: () => [],
      readClientRecords: () => [],
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 30);
    await expect(waiting).rejects.toMatchObject({ code: 'STIM_CANCELLED' });
  });

  describe('manifest requests from an Expo dev client', () => {
    const manifest = (
      stage: 'started' | 'finished' | 'failed',
      ts: number,
      requestId = 'm1',
      platform = 'android',
    ) => ({
      ts,
      src: 'metro',
      level: 'debug',
      event: `manifest_request_${stage}`,
      platform,
      requestId,
    });
    const run = async (records: NdjsonRecord[], platform: 'ios' | 'android' = 'android') => {
      const clock = fakeClock();
      const result = await verifyLaunch({
        since: clock.at(),
        platform,
        metroPort: 8082,
        now: clock.now,
        sleep: clock.sleep,
        readRecords: () => records.filter((record) => Number(record.ts) <= clock.at()),
      });
      return { result, elapsed: clock.at() - 1000 };
    };

    test('a served manifest that no bundle request follows is unverified once the grace after it passes', async () => {
      const { result, elapsed } = await run([manifest('started', 1000 + 16000), manifest('finished', 1000 + 18500)]);
      expect(result).toMatchObject({ verified: false, timedOut: true });
      expect(result.requested).toBeUndefined();
      expect(elapsed).toBe(18500 + MANIFEST_GRACE_MS);
    });

    test('a manifest request for the other platform, or one that failed, extends nothing', async () => {
      expect((await run([manifest('started', 1000 + 5000, 'm1', 'ios')])).elapsed).toBe(VERIFY_TIMEOUT_MS);
      expect((await run([manifest('started', 1000 + 5000), manifest('failed', 1000 + 6000)])).elapsed).toBe(
        VERIFY_TIMEOUT_MS,
      );
    });
  });

  test('an app that died before fetching a bundle is fatal at the deadline, with its device errors', async () => {
    const clock = fakeClock();
    const since = clock.at();
    const launchFailure = {
      ts: since + 600,
      src: 'device',
      platform: 'ios',
      level: 'error',
      msg: 'Application failed to launch: UIScene life cycle is required for apps built with this SDK.',
    };
    const probes: number[] = [];
    const result = await verifyLaunch({
      since,
      metroPort: 8084,
      platform: 'ios',
      now: clock.now,
      sleep: clock.sleep,
      readRecords: () => [],
      readDeviceRecords: () => [launchFailure],
      processAlive: () => {
        probes.push(clock.at());
        return false;
      },
    });
    expect(result).toMatchObject({ verified: false, fatal: true, processAlive: false, errors: [launchFailure] });
    expect(result.timedOut).toBeUndefined();
    expect(probes.every((at) => at >= since + VERIFY_TIMEOUT_MS)).toBe(true);
  });

  test('the alert stall: a bundle that arrives after the deadline does not retroactively verify', async () => {
    const clock = fakeClock();
    const result = await verifyLaunch({
      since: clock.at(),
      now: clock.now,
      sleep: clock.sleep,
      readRecords: () => (clock.at() > 1000 + 30000 ? [{ ts: clock.at(), event: 'bundle_build_started' }] : []),
    });
    expect(result.verified).toBe(false);
    expect(result.timedOut).toBe(true);
  });
});

describe('verifyLaunch: the stability window ends on evidence that the app JavaScript is running', () => {
  const since = 1000;
  const metro = (platform: 'ios' | 'android'): NdjsonRecord[] => [
    { ts: 1500, src: 'metro', platform, event: 'bundle_response_started', requestId: 'a' },
    { ts: 2000, src: 'metro', platform, event: 'bundle_response_finished', requestId: 'a' },
  ];
  const device = (platform: 'ios' | 'android', ts: number, msg: string): NdjsonRecord => ({
    ts,
    src: 'device',
    platform,
    level: 'info',
    msg,
  });
  const run = (
    platform: 'ios' | 'android',
    records: { metro?: NdjsonRecord[]; device: NdjsonRecord[] },
    extra: Parameters<typeof verifyLaunch>[0] = {},
  ) => {
    const clock = fakeClock();
    return verifyLaunch({
      since,
      platform,
      now: clock.now,
      sleep: clock.sleep,
      readRecords: () => (records.metro ?? metro(platform)).filter((r) => Number(r.ts) <= clock.at()),
      readDeviceRecords: () => records.device.filter((r) => Number(r.ts) <= clock.at()),
      readClientRecords: () => [],
      processAlive: () => true,
      ...extra,
    });
  };

  test('Android: a Running line from before the JavaScript bundle began loading is not evidence', async () => {
    const result = await run('android', {
      device: [
        { ...device('android', 2200, 'Running "launcher"'), proc: 'ReactNativeJS(1)' },
        {
          ...device('android', 2500, 'ReactHost{0}.getOrCreateReactInstanceTask(): Loading JS Bundle'),
          proc: 'unknown:BridgelessReact(1)',
          level: 'warn',
        },
        { ...device('android', 4000, 'Running "main"'), proc: 'ReactNativeJS(1)' },
      ],
    });
    expect(result).toMatchObject({ verified: true, jsRunning: true, waitedMs: 4000 + 500 - since });
  });
});

describe('optional app readiness', () => {
  test.each(['stalled'])('a %s bundle response cannot become verified from a build marker', async (outcome) => {
    const clock = fakeClock();
    const records: NdjsonRecord[] = [
      { ts: 1000, platform: 'android', event: 'bundle_response_started', requestId: 'a' },
      { ts: 2000, platform: 'android', event: 'bundle_build_done' },
      ...(outcome === 'failed'
        ? [
            {
              ts: 2500,
              platform: 'android',
              event: 'bundle_response_failed',
              requestId: 'a',
              level: 'error',
              msg: 'delivery failed',
            },
          ]
        : []),
    ];
    const result = await verifyLaunch({
      since: 1000,
      platform: 'android',
      now: clock.now,
      sleep: clock.sleep,
      readRecords: () => records.filter((r) => Number(r.ts) <= clock.at()),
      readDeviceRecords: () => [],
      readClientRecords: () => [],
    });
    expect(result.verified).toBe(false);
    expect(result).toMatchObject(
      outcome === 'stalled'
        ? { requested: true, timedOut: true, waitedMs: VERIFY_TIMEOUT_MS }
        : { fatal: true, waitedMs: 1500, errors: [{ msg: 'delivery failed' }] },
    );
  });

  function signal(ts: number, state: string, extra: Partial<NdjsonRecord> = {}): NdjsonRecord {
    return { ts, src: 'device', platform: 'ios', level: 'info', msg: `[stim:readiness] ${state}`, ...extra };
  }

  async function run(records: NdjsonRecord[], options: Partial<Parameters<typeof verifyLaunch>[0]> = {}) {
    const clock = fakeClock();
    let pendingNotices = 0;
    const result = await verifyLaunch({
      since: 1000,
      platform: 'ios',
      now: clock.now,
      sleep: clock.sleep,
      readRecords: () => [{ ts: 1000, event: 'bundle_build_done', platform: 'ios' }],
      readDeviceRecords: () => records.filter((record) => Number(record.ts) <= clock.at()),
      readClientRecords: () => [],
      processAlive: () => true,
      onReadinessPending: () => {
        pendingNotices += 1;
      },
      ...options,
    });
    return { result, pendingNotices };
  }

  test('missing ready is bounded and repeated pending cannot extend the deadline', async () => {
    const { result, pendingNotices } = await run([
      signal(1000, 'pending'),
      signal(3000, 'pending'),
      signal(30000, 'pending'),
      signal(31500, 'ready'),
    ]);
    expect(result).toMatchObject({ verified: true, readiness: 'timed-out', waitedMs: 30000 });
    expect(pendingNotices).toBe(1);
  });

  test.each([
    signal(500, 'pending'),
    signal(1500, 'pending', { platform: 'android' }),
    signal(1500, 'pending', { platform: undefined }),
    signal(1500, 'pending', { src: 'metro' }),
    signal(1500, 'pending', { src: 'build' }),
    signal(1500, 'pending', { level: 'error' }),
    signal(1500, 'pending', { msg: 'example: [stim:readiness] pending' }),
    signal(1500, 'pending', { msg: '[stim:readiness] pending\nother log' }),
  ])('does not opt in from stale, ambiguous, or embedded evidence: %j', async (record) => {
    const { result, pendingNotices } = await run([record, signal(5000, 'ready')]);
    expect(result).toMatchObject({ verified: true, waitedMs: 3000 });
    expect(result.readiness).toBeUndefined();
    expect(pendingNotices).toBe(0);
  });

  test('an app error interrupts the wait even when ready is present', async () => {
    const { result } = await run([signal(1000, 'pending'), signal(1500, 'ready')], {
      readClientRecords: () => [{ ts: 1000, src: 'client', platform: 'ios', level: 'error', msg: 'startup failed' }],
    });
    expect(result).toMatchObject({ verified: true, readiness: 'error', processAlive: true, waitedMs: 0 });
    expect(result.errors?.[0]?.msg).toBe('startup failed');
  });
});

describe('unverifiedLaunchLines', () => {
  test('with no scheme it restarts the exact app without attaching a console', async () => {
    const text = unverifiedLaunchLines({ platform: 'ios', metroPort: 8082, bundleId: 'com.x', udid: 'U1' }).join('\n');
    expect(text).toContain('Re-launch: xcrun simctl launch --terminate-running-process U1 com.x');
    expect(text).not.toMatch(/DEVELOPMENT SERVERS/);
    expect(text).not.toContain('--console');
  });

  describe.skipIf(process.platform === 'win32')(
    'printed Android deep links through a real POSIX sh (skipped on win32)',
    () => {
      test.each([androidDevClientUrl('exp+app', 8082), `${androidDevClientUrl('exp+app', 8082)}&probe=O'Brien`])(
        'preserves the complete URL and extras through both shells: %s',
        (url) => {
          const lines = unverifiedLaunchLines({
            platform: 'android',
            metroPort: 8082,
            bundleId: 'com.x',
            serial: 'emulator-5584',
            devClientUrl: url,
          });
          const commands = lines.filter((line) => line.includes('adb -s') && line.includes(' -d '));
          expect(commands).toHaveLength(2);
          for (const line of commands) {
            const command = line.slice(line.indexOf('adb -s'));
            const output = execFileSync(
              '/bin/sh',
              [
                '-c',
                `adb() {
              [ "$1" = -s ] && [ "$2" = emulator-5584 ] && [ "$3" = shell ] || return 1
              shift 3
              /bin/sh -c 'am() { printf "%s\\n" "$@"; }; '"$*"
            }
            ${command}`,
              ],
              { encoding: 'utf8' },
            );
            expect(output.trimEnd().split('\n')).toEqual([
              ...(command.includes('force-stop') ? ['force-stop', 'com.x'] : []),
              'start',
              '-a',
              'android.intent.action.VIEW',
              '-d',
              url,
              '--ez',
              'EXDevMenuDisableAutoLaunch',
              'true',
            ]);
          }
        },
      );
    },
  );
});

describe.skipIf(process.platform === 'win32')(
  'the debug_http_host script, run for real under sh (skipped on win32)',
  () => {
    let dir: string;
    const PKG = 'com.example.app';
    const prefsPath = () => join(dir, 'shared_prefs', `${PKG}_preferences.xml`);

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'stim-prefs-'));
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    const runScript = (port: number) =>
      execFileSync(
        '/bin/sh',
        [
          '-c',
          `sh -c ${deviceShellArg(debugHttpHostScript({ packageName: PKG, host: `10.0.2.2:${port}`, dataDir: dir }))}`,
        ],
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
      );

    const parsePrefs = (text: string) => {
      const entries: Record<string, string> = {};
      const stack: Array<{ name: string; attrs: Record<string, string> }> = [];
      const tag = /<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*"[^"]*")*)\s*(\/?)>/g;
      const body = text.replace(/<\?xml[^>]*\?>/g, '');
      let last = 0;
      let m;
      while ((m = tag.exec(body)) !== null) {
        const [full, closing, name, attrs, selfClosing] = m;
        if (full === undefined || name === undefined || attrs === undefined) continue;
        const between = body.slice(last, m.index);
        last = m.index + full.length;
        if (closing) {
          const open = stack.pop();
          assert(open);
          expect(open.name).toBe(name);
          const key = open.attrs.name;
          if (name === 'string' && key !== undefined) entries[key] = between;
          continue;
        }
        const attrMap: Record<string, string> = {};
        for (const a of attrs.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) {
          const k = a[1];
          const v = a[2];
          if (k !== undefined && v !== undefined) attrMap[k] = v;
        }
        if (selfClosing) {
          const key = attrMap.name;
          if (name === 'string' && key !== undefined) entries[key] = '';
          continue;
        }
        stack.push({ name, attrs: attrMap });
      }
      expect(stack).toEqual([]);
      expect(body.trim()).toMatch(/^<map>[\s\S]*<\/map>$/);
      return entries;
    };

    test('case 1: no prefs file at all', async () => {
      runScript(8085);
      const entries = parsePrefs(readFileSync(prefsPath(), 'utf-8'));
      expect(entries).toEqual({ debug_http_host: '10.0.2.2:8085' });
    });

    test('case 2: a prefs file that already carries the key (the value is replaced, once)', async () => {
      runScript(8085);
      runScript(8099);
      const text = readFileSync(prefsPath(), 'utf-8');
      expect(parsePrefs(text)).toEqual({ debug_http_host: '10.0.2.2:8099' });
      const hostMatches = text.match(/debug_http_host/g);
      assert(hostMatches);
      expect(hostMatches.length).toBe(1);
    });

    test('case 3: a prefs file WITHOUT the key keeps every other entry', async () => {
      execFileSync('/bin/sh', ['-c', `mkdir -p ${join(dir, 'shared_prefs')}`]);
      writeFileSync(
        prefsPath(),
        [
          "<?xml version='1.0' encoding='utf-8' standalone='yes' ?>",
          '<map>',
          '    <string name="onboarding">done</string>',
          '    <string name="last_route">/settings?tab=1&amp;q=x</string>',
          '</map>',
          '',
        ].join('\n'),
      );
      runScript(8085);
      expect(parsePrefs(readFileSync(prefsPath(), 'utf-8'))).toEqual({
        onboarding: 'done',
        last_route: '/settings?tab=1&amp;q=x',
        debug_http_host: '10.0.2.2:8085',
      });
    });

    test("case 4: Android's empty-prefs form, `<map />`", async () => {
      execFileSync('/bin/sh', ['-c', `mkdir -p ${join(dir, 'shared_prefs')}`]);
      writeFileSync(prefsPath(), "<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n<map />\n");
      runScript(8085);
      expect(parsePrefs(readFileSync(prefsPath(), 'utf-8'))).toEqual({ debug_http_host: '10.0.2.2:8085' });
    });

    test('a data directory that does not exist exits non-zero rather than pretending', async () => {
      const script = debugHttpHostScript({ packageName: PKG, host: '10.0.2.2:8085', dataDir: join(dir, 'nope') });
      expect(() => execFileSync('/bin/sh', ['-c', `sh -c ${deviceShellArg(script)}`], { stdio: 'ignore' })).toThrow(
        Error,
      );
    });

    test('the script is multi-line, and every line survives the quoting', async () => {
      const script = debugHttpHostScript({ packageName: PKG, host: '10.0.2.2:8085' });
      expect(script.split('\n').length >= 6).toBeTruthy();
      expect(script).toMatch(/^cd \/data\/data\/com\.example\.app \|\| exit 1$/m);
      expect(script).not.toMatch(/\\"/);
      const roundTripped = execFileSync('/bin/sh', ['-c', `printf %s ${deviceShellArg(script)}`], {
        encoding: 'utf-8',
      });
      expect(roundTripped).toBe(script);
    });
  },
);

describe('the Android dev-client deep link', () => {
  test('a deep link nothing answers falls back to the launcher and says so', async () => {
    const exec = recordingExec({
      outputs: {
        'android.intent.action.VIEW':
          'Starting: Intent { act=android.intent.action.VIEW dat=exp+app://expo-development-client/... }\nError: Activity not started, unable to resolve Intent { act=android.intent.action.VIEW }',
        'resolve-activity': 'priority=0 isDefault=true\ncom.example.app/.MainActivity\n',
      },
    });
    const result: LaunchResult = await launchAndroidApp(
      { serial: 'emulator-5554', packageName: 'com.example.app', metroPort: 8082, devClientScheme: 'exp+app' },
      { exec },
    );
    expect(result.ok).toBe(true);
    expect(result.mode).toBe('am-start');
    expect(result.devClientNote).toMatch(/unable to resolve Intent/);
    expect(result.devClientNote).toMatch(/fell back to the launcher activity/);
    expect(exec.calls.at(-1)).toEqual([
      'adb',
      '-s',
      'emulator-5554',
      'shell',
      'am',
      'start',
      '-n',
      'com.example.app/.MainActivity',
    ]);
  });

  test.skipIf(process.platform === 'win32')(
    'every deviceShellArg quoting round-trips unchanged (real POSIX sh; skipped on win32)',
    () => {
      for (const raw of ['a b', "it's", 'x\ny', '?url=a&b=c', '$HOME `id`', '<map>']) {
        expect(execFileSync('/bin/sh', ['-c', `printf %s ${deviceShellArg(raw)}`], { encoding: 'utf-8' })).toBe(raw);
      }
    },
  );
});

describe('the android release process proof', () => {
  test('a device with no pidof falls through to ps -A', async () => {
    const exec = recordingExec({
      fail: 'pidof',
      outputs: { 'ps -A': 'USER PID\nu0_a1 4242 310 1 1 0 0 S com.example.app\n' },
    });
    const result = await verifyAndroidReleaseLaunch({
      serial: 'emulator-5584',
      packageName: 'com.example.app',
      exec,
      sleep: async () => {},
    });
    expect(result.verified).toBe(true);
    expect(result.pid).toBe(4242);
  });

  test('a failed process probe is unverified without claiming the app exited', async () => {
    const exec = recordingExec({ fail: 'adb' });
    expect(await androidAppProcess('emulator-5584', 'com.example.app', { exec })).toEqual({ state: 'unknown' });
    const result = await verifyAndroidReleaseLaunch({
      serial: 'emulator-5584',
      packageName: 'com.example.app',
      exec,
      sleep: async () => {},
    });
    expect(result).toMatchObject({ verified: false, reason: 'probe-failed' });
  });
});

describe('isBundleRequestProof', () => {
  test("another workspace's port is never proof -- that is the failure this check exists for", async () => {
    expect(
      isBundleRequestProof({ ts: 150, src: 'device', msg: 'Loading http://10.0.2.2:8081/index.bundle' }, 100, 8082),
    ).toBe(false);
  });

  test('a URL with no bundle path, a record from before the launch, and a missing port are all not proof', async () => {
    expect(
      isBundleRequestProof({ ts: 150, src: 'device', msg: 'connected to http://localhost:8082/' }, 100, 8082),
    ).toBe(false);
    expect(isBundleRequestProof({ ts: 99, src: 'device', msg: 'http://localhost:8082/index.bundle' }, 100, 8082)).toBe(
      false,
    );
    expect(isBundleRequestProof({ ts: 150, msg: 'http://localhost:8082/index.bundle' }, 100, null)).toBe(false);
    expect(isBundleRequestProof(null, 100, 8082)).toBe(false);
  });
});

describe('verifyLaunch: still bundling', () => {
  test("another platform's bundle failure does not fail this launch", async () => {
    const clock = fakeClock();
    const since = clock.at();
    const result = await verifyLaunch({
      since,
      platform: 'ios',
      now: clock.now,
      sleep: clock.sleep,
      readRecords: () => [
        {
          ts: since + 10,
          event: 'bundle_build_failed',
          buildID: 'android_1',
          platform: 'android',
          level: 'error',
          msg: 'Android failed',
        },
        {
          ts: since + 11,
          event: 'bundling_error',
          buildID: 'android_1',
          platform: 'android',
          level: 'error',
          msg: 'Unable to resolve AndroidOnly',
        },
        { ts: since + 20, event: 'bundle_build_done', buildID: 'ios_1', platform: 'ios' },
      ],
      readDeviceRecords: () => [],
      processAlive: () => true,
    });
    expect(result).toMatchObject({ verified: true, processAlive: true });
    expect(result.errors).toEqual([]);
  });

  test('a process exit during the readiness window is fatal', async () => {
    const clock = fakeClock();
    const since = clock.at();
    const result = await verifyLaunch({
      since,
      now: clock.now,
      sleep: clock.sleep,
      readRecords: () => [{ ts: since + 10, event: 'bundle_build_done' }],
      readDeviceRecords: () => [],
      processAlive: () => false,
    });
    expect(result).toMatchObject({ verified: false, fatal: true, processAlive: false });
  });
});

describe('the 8081 adb reverse is a fallback, not a default', () => {
  function execRecording(prefsOk: boolean) {
    const calls: string[][] = [];
    return {
      calls,
      exec: asyncMock({
        runFile: (cmd: string, args: string[]) => {
          calls.push([cmd, ...args]);
          if (!prefsOk && args.includes('run-as')) throw new Error('run-as: package not debuggable');
          if (args.includes('resolve-activity')) return 'com.example.app/.MainActivity';
          return '';
        },
      }),
    };
  }
  const reverses = (calls: string[][]) => calls.filter((c) => c.includes('reverse')).map((c) => c.slice(-2).join(' '));

  test('a failed prefs write adds the 8081 fallback so the app still finds Metro', async () => {
    const { calls, exec } = execRecording(false);
    const result: LaunchResult = await launchAndroidApp(
      { serial: 'RFCR7081Q9L', packageName: 'com.example.app', metroPort: 8082, physical: true },
      { exec },
    );
    expect(result.ok).toBe(true);
    expect(reverses(calls)).toEqual(['tcp:8082 tcp:8082', 'tcp:8081 tcp:8082']);
    expect(result.debugHttpHost).toBeNull();
    expect(result.debugHttpHostNote).toMatch(/relying on adb reverse/);
  });

  test('the same-port mapping is registered before the prefs write, so the app can never race ahead of it', async () => {
    const { calls, exec } = execRecording(true);
    await launchAndroidApp({ serial: 'emulator-5554', packageName: 'com.example.app', metroPort: 8082 }, { exec });
    const order = calls.map((c) => (c.includes('reverse') ? 'reverse' : c.includes('run-as') ? 'prefs' : 'other'));
    expect(order.indexOf('reverse')).toBeLessThan(order.indexOf('prefs'));
  });
});

describe('skipping an install the device already holds', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'stim-identical-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function localApp(name: string, body: string) {
    const path = join(dir, name);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'Fixture'), body);
    return path;
  }

  test('an identical .app that adoption cleared skips the dev-menu writes: the launch carries them instead', async () => {
    const installed = localApp('installed.app', 'macho');
    const appPath = localApp('built.app', 'macho');
    const exec = recordingExec({ outputs: { get_app_container: `${installed}\n` } });
    const result = await installIosApp(
      {
        udid: 'U1',
        appPath,
        bundleId: 'com.example.app',
        devClientScheme: 'myapp',
        schemeApprovals: [
          'com.apple.CoreSimulator.CoreSimulatorBridge-->com.example.app=com.example.app',
          'com.apple.CoreSimulator.CoreSimulatorBridge-->myapp=com.example.app',
        ],
      },
      { exec, now: () => 0 },
    );
    expect(result.skipped).toBe(true);
    expect(exec.calls.some((c) => c.includes('write'))).toBe(false);
    expect(result.devClientPreparationDurationMs).toBeUndefined();
  });
});

describe('launch verification after Metro prefetch', () => {
  test.each(['bare'])('a late %s prefetch completion is not app activity', async (mode) => {
    const clock = fakeClock();
    const result = await verifyLaunch({
      requireBundleResponse: true,
      platform: 'ios',
      since: 1000,
      readRecords: () => [
        {
          ts: 1500,
          src: 'metro',
          platform: 'ios',
          event: mode === 'bare' ? 'bundle_build_done' : 'expo_stdout',
          msg: 'iOS Bundled 500ms index.js',
        },
      ],
      readDeviceRecords: () => [],
      readClientRecords: () => [],
      now: clock.now,
      sleep: clock.sleep,
      timeoutMs: 2000,
    });
    expect(result.verified).toBe(false);
    expect(result.requested).not.toBe(true);
  });
});

describe('verifyLaunch: bundle deliveries in a workspace with device slots', () => {
  const delivery = (at: number, fields: Record<string, unknown> = {}) => [
    { ts: at, src: 'metro', event: 'bundle_response_started', platform: 'ios', requestId: 'r1', ...fields },
    { ts: at, src: 'metro', event: 'bundle_response_finished', platform: 'ios', requestId: 'r1', ...fields },
  ];
  const verifySlot = (records: NdjsonRecord[], options: { appPid?: number; platformShared?: boolean }) => {
    const clock = fakeClock();
    return verifyLaunch({
      slot: 'phone',
      platform: 'ios',
      requireBundleResponse: true,
      since: clock.at(),
      timeoutMs: 100,
      pollMs: 25,
      stabilityMs: 0,
      now: clock.now,
      sleep: clock.sleep,
      readRecords: () => records.map((record) => ({ ...record, ts: clock.at() })),
      readDeviceRecords: () => [],
      readClientRecords: () => [],
      ...options,
    });
  };

  test("a sibling simulator's delivery is not this launch's, and is not called ambiguous", async () => {
    const result = await verifySlot(delivery(0, { clientPid: 42 }), { appPid: 41, platformShared: true });
    expect(result).toMatchObject({ verified: false, timedOut: true });
    expect(result.unattributed).toBeUndefined();
  });

  test("this device's own logged request still reports bundling beside an unattributed delivery", async () => {
    const clock = fakeClock();
    const result = await verifyLaunch({
      slot: 'phone',
      platform: 'ios',
      requireBundleResponse: true,
      platformShared: true,
      metroPort: 8083,
      since: clock.at(),
      timeoutMs: 100,
      pollMs: 25,
      now: clock.now,
      sleep: clock.sleep,
      readRecords: () => delivery(clock.at()),
      readDeviceRecords: () => [
        { ts: clock.at(), src: 'device', slot: 'phone', msg: 'GET http://localhost:8083/index.bundle?platform=ios' },
      ],
      readClientRecords: () => [],
    });
    expect(result).toMatchObject({ verified: false, requested: true });
    expect(result.unattributed).toBeUndefined();
  });
});

test.skipIf(process.platform === 'win32')(
  'a simulator install leaves the event loop free while simctl runs (POSIX executable stub; skipped on win32)',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stim-install-loop-'));
    const previousPath = process.env.PATH;
    try {
      writeFileSync(join(dir, 'xcrun'), '#!/bin/sh\nsleep 0.5\n', { mode: 0o755 });
      process.env.PATH = `${dir}:${previousPath}`;
      let ticks = 0;
      const timer = setInterval(() => (ticks += 1), 20);
      const installed = await installIosApp({ udid: 'U1', appPath: join(dir, 'App.app') }).finally(() =>
        clearInterval(timer),
      );
      expect(installed).toEqual({ ok: true, appPath: join(dir, 'App.app') });
      expect(ticks).toBeGreaterThan(5);
    } finally {
      process.env.PATH = previousPath;
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
