import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { machineCacheUsageFile, readMachineCacheUsage } from '@stim-cli/core/state';
import { getMachineCacheReport } from '../devices/machine-cache-usage.ts';
import { machineCacheLines } from '../devices/machine-cache-usage-output.ts';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { saveConfig, upsertProject } from '../workspace/config.ts';
import { withAmbientContext } from '@stim-cli/core';
import { captureProcessIdentity, inspectProcessIdentity, waitForProcessExit } from '@stim-cli/core/process-identity';
import { readClaimSet } from '../ownership-claim.ts';
import { withWorkspaceProcessLock } from '../engine/workspace-process-lock.ts';
import { runReport } from '../report-runtime.ts';
import { testContext } from './_context.ts';

const UNUSED_RUNTIME = '88E8478B-6BAD-4120-A046-0F9F9221E17A';
const USED_RUNTIME = '244912DF-0671-4197-9C70-85AF161BF600';
const BUNDLED_RUNTIME = '11111111-2222-3333-4444-555555555555';

const runtimeList = JSON.stringify({
  [UNUSED_RUNTIME]: {
    identifier: UNUSED_RUNTIME,
    platformIdentifier: 'com.apple.platform.iphonesimulator',
    runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.iOS-27-1',
    version: '27.1',
    build: '24A94401',
    sizeBytes: 7_873_719_649,
    deletable: true,
    lastUsedAt: '2026-10-09T00:49:33Z',
  },
  [USED_RUNTIME]: {
    identifier: USED_RUNTIME,
    platformIdentifier: 'com.apple.platform.iphonesimulator',
    runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.iOS-27-0',
    version: '27.0',
    build: '24A434',
    sizeBytes: 8_067_000_161,
    deletable: true,
    lastUsedAt: '2026-10-14T08:08:50Z',
  },
  [BUNDLED_RUNTIME]: {
    identifier: BUNDLED_RUNTIME,
    platformIdentifier: 'com.apple.platform.iphonesimulator',
    runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.iOS-18-6',
    version: '18.6',
    build: '22G1',
    sizeBytes: 100,
    deletable: false,
    lastUsedAt: null,
  },
});

const deviceList = JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-27-0': ['A', 'B'].map((udid) => ({
      udid,
      name: `iPhone ${udid}`,
      state: 'Shutdown',
      deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17',
      isAvailable: false,
    })),
    'com.apple.CoreSimulator.SimRuntime.iOS-27-1': [],
  },
});

let home: string;
let gradle: string;
let platform: NodeJS.Platform;
let calls: string[][];
let tools: Record<string, string | Error>;
let gitTop: string | null;

function writeDirs(...dirs: string[]) {
  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'keep'), dir);
  }
}

function wrapper(project: string, version: string) {
  const dir = join(project, 'android', 'gradle', 'wrapper');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'gradle-wrapper.properties'),
    `distributionBase=GRADLE_USER_HOME\ndistributionUrl=https\\://services.gradle.org/distributions/gradle-${version}-all.zip\n`,
  );
}

/** unique-pid loads its native addon for process.platform, so fake darwin only after setup that takes claims. */

beforeEach(() => {
  home = realpathSync.native(mkdtempSync(join(tmpdir(), 'stim-machine-caches-')));
  gradle = join(home, '.gradle');
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('STIM_HOME', join(home, 'stim'));
  vi.stubEnv('GRADLE_USER_HOME', '');
  platform = process.platform;
  saveConfig({ version: 2, projects: {}, repos: {} });
  calls = [];
  gitTop = null;
  tools = {
    'xcrun simctl runtime list -j': runtimeList,
    'xcrun simctl list devices --json': deviceList,
    'xcodebuild -version': 'Xcode 27.0\nBuild version 27A266a\n',
    'agent-device --version': '0.21.22\n',
  };
  setExecutor({
    runFileAsync: async (file: string, args: string[]) => {
      if (file === 'git') {
        if (gitTop && args.includes('--show-toplevel')) return `${gitTop}\n`;
        throw new Error('not a git repository');
      }
      calls.push([file, ...args]);
      if (file === 'du') return `2048\t${args.at(-1)}\n`;
      const result = tools[[file, ...args].join(' ')];
      if (result === undefined || result instanceof Error) throw result ?? new Error('unexpected');
      return result;
    },
    runFileQuietAsync: async () => null,
  });
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: platform });
  resetExecutor();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

test('machine report probes serialize their real children on the operation ownership claim', async () => {
  writeDirs(join(gradle, 'caches', 'modules-2'), join(gradle, 'caches', '9.4.1'));
  for (const name of ['first-project', 'second-project']) {
    const project = join(home, name);
    wrapper(project, '9.3.1');
    upsertProject(project, {});
  }
  resetExecutor();
  const executor = getExecutor();
  const original = executor.runFileAsync.bind(executor);
  const children: { pid: number; processToken: string }[] = [];
  const recorded: (number | undefined)[] = [];
  let claimRoot = '';
  let active = 0;
  let peak = 0;
  const probe = vi.spyOn(executor, 'runFileAsync').mockImplementation((file, args, options) => {
    const output = file === 'du' ? `2048\t${args.at(-1)}\n` : (tools[[file, ...args].join(' ')] ?? '');
    if (output instanceof Error) return Promise.reject(output);
    return original(process.execPath, ['-e', 'console.log(process.argv[1]); setTimeout(()=>{},80)', output], {
      ...options,
      onSpawn: (child) => {
        options.onSpawn?.(child);
        const birth = child.pid === undefined ? null : captureProcessIdentity(child.pid);
        if (!birth?.ok || child.pid === undefined) throw new Error('The machine report child has no identity');
        children.push({ pid: child.pid, processToken: birth.token });
        recorded.push(readClaimSet(claimRoot).live[0]?.child?.pid);
        peak = Math.max(peak, ++active);
        child.once('close', () => active--);
      },
    });
  });
  try {
    const report = await runReport(testContext({ cwd: home, projectRoot: home }), (operation) =>
      withAmbientContext(operation, () =>
        withWorkspaceProcessLock(
          home,
          'machine-report',
          (claim) => {
            claimRoot = claim.root;
            return getMachineCacheReport(null, { operation });
          },
          { external: true, declareSpawnsFor: operation },
        ),
      ),
    );
    expect(report.gradle.unusedVersions).toMatchObject([{ version: '9.4.1', bytes: 2_097_152 }]);
    expect(children.length).toBeGreaterThan(1);
    expect(recorded).toEqual(children.map((child) => child.pid));
    expect(peak).toBe(1);
    expect(active).toBe(0);
    expect(readClaimSet(claimRoot).live).toEqual([]);
  } finally {
    probe.mockRestore();
    for (const child of children) {
      if (inspectProcessIdentity(child) === 'same') process.kill(child.pid, 'SIGKILL');
      expect(await waitForProcessExit(child, 5000)).toBe(true);
    }
  }
});

test('reuses a measurement for ten minutes and measures again when the measured dirs change', async () => {
  const caches = join(gradle, 'caches');
  writeDirs(join(caches, '9.3.1'));
  await getMachineCacheReport(null);
  const first = calls.length;
  await getMachineCacheReport(null);
  expect(calls).toHaveLength(first);

  const project = join(home, 'app');
  wrapper(project, '9.3.1');
  upsertProject(project, {});
  const report = await getMachineCacheReport(null);
  expect(calls.length).toBeGreaterThan(first);
  expect(report.gradle.unusedVersions).toEqual([]);

  const count = calls.length;
  writeFileSync(
    machineCacheUsageFile(),
    JSON.stringify({ ...readMachineCacheUsage(), measuredAt: new Date(Date.now() - 600_000).toISOString() }),
  );
  await getMachineCacheReport(null);
  expect(calls.length).toBeGreaterThan(count);

  const before = calls.length;
  writeFileSync(machineCacheUsageFile(), JSON.stringify({ version: 1, measuredAt: 'not a date' }));
  await getMachineCacheReport(null);
  expect(calls.length).toBeGreaterThan(before);
  expect(readMachineCacheUsage()?.version).toBe(1);
});

const posixModes = process.getuid?.() !== 0 && process.platform !== 'win32';

test.skipIf(!posixModes)('an unreadable wrapper is reported like an unreadable project, never as no pin', async () => {
  writeDirs(join(gradle, 'caches', '9.3.1'));
  const project = join(home, 'app');
  wrapper(project, '9.3.1');
  const file = join(project, 'android', 'gradle', 'wrapper', 'gradle-wrapper.properties');
  chmodSync(file, 0o000);
  upsertProject(project, {});
  try {
    const report = await getMachineCacheReport(null);
    expect(report.gradle.unreadableProjects).toEqual([project]);
    expect(machineCacheLines(report).join('\n')).toContain('missing or unreadable');
  } finally {
    chmodSync(file, 0o644);
  }
});

test('off macOS no simulator line appears, since simctl is never asked', async () => {
  Object.defineProperty(process, 'platform', { value: 'linux' });
  const report = await getMachineCacheReport(null);
  expect(report.simRuntimes).toEqual({ checked: true, runtimes: [] });
  expect(report.complete).toBe(true);
  expect(calls.some(([file]) => file === 'xcrun')).toBe(false);
  expect(machineCacheLines(report)).toEqual([]);
});

const spoilers: [string, (file: string) => void][] = [
  ['names no version', (file) => writeFileSync(file, 'distributionBase=GRADLE_USER_HOME\n')],
];
if (posixModes) spoilers.push(['cannot be read', (file) => chmodSync(file, 0o000)]);
