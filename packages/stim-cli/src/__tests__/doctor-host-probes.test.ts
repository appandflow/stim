import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { detectXcodeMajorAsync } from '../engine/xcode.ts';
import { readHostMemoryPressureAsync } from '../host-memory.ts';
import { readMemoryCulpritsAsync } from '../memory-culprits.ts';
import { reactNativeDoctorFindings, runDoctor, type DoctorContext } from '../diagnostics/doctor.ts';
import { reactNativeProjectDoctor } from '../integrations/react-native-doctor.ts';
import { projectIntegrations } from '../integrations/projects.ts';
import { runReport } from '../report-runtime.ts';
import { withAmbientContext, type StimContext } from '@stim-cli/core';

let base: string;
let root: string;
beforeEach(() => {
  resetExecutor();
  base = mkdtempSync(join(tmpdir(), 'stim-doctor-host-'));
  process.env.STIM_HOME = join(base, 'home');
  root = join(base, 'project');
  mkdirSync(root);
  getExecutor().runFile('git', ['init', '-q', root], { timeoutMs: 5000 });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'fixture', dependencies: { 'react-native': '0.81.0' } }),
  );
});
afterEach(() => {
  resetExecutor();
  delete process.env.STIM_HOME;
  rmSync(base, { recursive: true, force: true });
});

async function responsive<T>(read: () => Promise<T>): Promise<T> {
  let ticks = 0;
  const timer = setInterval(() => ticks++, 10);
  try {
    const result = await read();
    expect(ticks).toBeGreaterThan(0);
    return result;
  } finally {
    clearInterval(timer);
  }
}

function delayedHostProbe() {
  const real = getExecutor();
  const calls: string[] = [];
  const executor = {
    ...real,
    async runFileQuietAsync(file: string, _args: string[], options: Parameters<typeof real.runFileQuietAsync>[2]) {
      calls.push(file);
      const output =
        file === 'xcodebuild'
          ? 'Xcode 26.0\nBuild version 17A\n'
          : file === '/usr/sbin/sysctl'
            ? '4\n'
            : file === '/usr/bin/top'
              ? 'PID MEM COMMAND\n123 14G java\n'
              : '123 java org.gradle.launcher.daemon.bootstrap.GradleDaemon\n';
      return real.runFileQuietAsync(
        process.execPath,
        ['-e', `setTimeout(() => process.stdout.write(${JSON.stringify(output)}), 200)`],
        options,
      );
    },
  };
  return { executor, calls };
}

test('Xcode and pressure reads yield while their children run and preserve parsed observations', async () => {
  const { executor } = delayedHostProbe();
  expect(await responsive(() => detectXcodeMajorAsync(executor))).toBe(26);
  expect(await responsive(() => readHostMemoryPressureAsync(executor, 'darwin'))).toBe('critical');
});

test('memory culprit reads yield for top and ps and retain the Java daemon diagnosis', async () => {
  const { executor, calls } = delayedHostProbe();
  expect(await responsive(() => readMemoryCulpritsAsync(executor, 'darwin', 48 * 1024 ** 3))).toMatchObject([
    { pid: 123, name: 'Gradle daemon', command: 'stim gc --delete --cache gradle-daemons' },
  ]);
  expect(calls).toEqual(['/usr/bin/top', '/bin/ps']);
  calls.length = 0;
  expect(await readMemoryCulpritsAsync(executor, 'linux')).toBeNull();
  expect(await readHostMemoryPressureAsync(executor, 'linux')).toBeNull();
  expect(calls).toEqual([]);
});

test('doctor awaits asynchronous pressure only for local iOS and keeps corrupt settings closed', async () => {
  const pressure = vi.fn<() => Promise<'critical'>>(async () => 'critical');
  const options = {
    memoryPressure: pressure,
    host: 'darwin' as const,
    platform: 'ios' as const,
    platforms: ['ios' as const],
    concurrency: { maxBuilds: 0, maxDevices: 0 },
    machineSettings: { settings: {}, layers: [], corrupt: null },
  };
  const observed = await runDoctor(root, options);
  expect(observed.findings).toContainEqual(
    expect.objectContaining({
      title: 'Host memory pressure can stall the iOS simulator',
      detail: expect.stringContaining('critical host memory pressure'),
    }),
  );
  pressure.mockClear();
  await runDoctor(root, { ...options, platform: 'android' });
  await runDoctor(root, {
    ...options,
    machineSettings: { ...options.machineSettings, settings: { ios: { remote: 'eas' } } },
  });
  await runDoctor(root, {
    ...options,
    machineSettings: {
      ...options.machineSettings,
      corrupt: { level: 'note', title: 'corrupt', detail: 'bad', fix: null },
    },
  });
  expect(pressure).not.toHaveBeenCalled();
});

test.each([false, true])(
  'doctor global EAS version read yields for remote devices and build downloads (download: %s)',
  async (download) => {
    const sdk = join(base, 'global-sdk');
    mkdirSync(sdk);
    const cli = join(sdk, 'eas.mjs');
    writeFileSync(cli, '#!/usr/bin/env node\nsetTimeout(() => console.log("eas-cli/999.0.0"), 250);\n', {
      mode: 0o755,
    });
    if (download) writeFileSync(join(root, 'eas.json'), '{}');
    const real = getExecutor();
    setExecutor({ ...real, findExecutable: (name) => (name === 'eas' ? cli : real.findExecutable(name)) });
    const findings = await responsive(() =>
      reactNativeDoctorFindings({
        root,
        repoRoot: root,
        settings: download ? {} : { android: { remote: 'eas' } },
        optimizations: null,
        platforms: ['android'],
        options: {
          platform: 'android',
          host: 'linux',
          lookupAgentDevice: () => true,
          lookupEasCli: () => true,
          tailnetStatus: () => null,
        },
      }),
    );
    expect(
      findings.some((finding) =>
        /version could not be read|has no EAS Simulator|cannot download EAS/.test(finding.title),
      ),
    ).toBe(false);
    expect(findings.some((finding) => finding.title === 'This project uses a remote device')).toBe(!download);
  },
);

function reportContext(signal: AbortSignal, env: NodeJS.ProcessEnv = process.env): StimContext {
  return {
    home: join(base, 'home'),
    buildCache: null,
    projectRoot: root,
    cwd: root,
    env: { ...env },
    runId: 'doctor-offload-fixture',
    signal,
    output: () => {},
  };
}
function targetContext(operation: StimContext): DoctorContext {
  return {
    root,
    settings: {},
    optimizations: null,
    platforms: [],
    repoRoot: null,
    options: { operation, host: 'darwin' },
  };
}

test('Android doctor targets use the requesting client JDK instead of the host environment', async () => {
  const client = join(base, 'client-jdk');
  mkdirSync(client);
  writeFileSync(join(client, 'release'), 'JAVA_VERSION="17.0.19"\n');
  vi.stubEnv('JAVA_HOME', join(base, 'host-jdk-missing'));
  const operation = reportContext(new AbortController().signal, { ...process.env, JAVA_HOME: client });
  const inspect = reactNativeProjectDoctor(root).offloadTargets?.(
    { ...targetContext(operation), options: { operation, platform: 'android' } },
    async () => null,
  );
  if (!inspect) throw new Error('The Android doctor target was not selected');
  try {
    const targets = await withAmbientContext(operation, inspect);
    expect(targets[0]?.local).toMatchObject({ jdk: '17' });
  } finally {
    vi.unstubAllEnvs();
  }
});

test('Swift doctor target probes yield and drain on report cancellation', async () => {
  writeFileSync(join(root, 'Package.swift'), '// swift-tools-version: 5.9\n');
  const integration = projectIntegrations.find((entry) => entry.id === 'swift-package');
  const doctor = await integration?.inspect(root)?.doctor?.();
  if (!doctor) throw new Error('The Swift project doctor was not selected');
  const controller = new AbortController();
  const cancellation = new Error('fixture cancellation');
  const executor = getExecutor();
  const original = executor.runFileAsync.bind(executor);
  const pids: number[] = [];
  const sync = vi.spyOn(executor, 'runFileQuiet').mockReturnValue(null);
  const probe = vi.spyOn(executor, 'runFileAsync').mockImplementation((file, args, options) =>
    file === 'xcodebuild' || file === 'xcrun'
      ? original(process.execPath, ['-e', 'console.log("ready"); setTimeout(() => {}, 3000)'], {
          ...options,
          onSpawn: (child) => {
            if (child.pid !== undefined) pids.push(child.pid);
            child.stdout?.once('data', () => controller.abort(cancellation));
          },
        })
      : original(file, args, options),
  );
  try {
    await expect(
      runReport(reportContext(controller.signal), (operation) =>
        withAmbientContext(operation, async () => {
          const inspect = doctor.offloadTargets?.(targetContext(operation), async () => null);
          if (!inspect) throw new Error('The macOS doctor target was not selected');
          return inspect();
        }),
      ),
    ).rejects.toBe(cancellation);
    expect(sync).not.toHaveBeenCalled();
    expect(pids.length).toBeGreaterThan(0);
    for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
  } finally {
    controller.abort();
    probe.mockRestore();
    sync.mockRestore();
  }
});
