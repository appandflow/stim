import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { detectXcodeMajorAsync } from '../engine/xcode.ts';
import { readHostMemoryPressureAsync } from '../host-memory.ts';
import { readMemoryCulpritsAsync } from '../memory-culprits.ts';
import { reactNativeDoctorFindings, runDoctor } from '../diagnostics/doctor.ts';

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
