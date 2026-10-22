import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectIosDebugArchitectures, parseIosDebugArchitectures } from '../diagnostics/doctor-ios-architectures.ts';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';

function target(settings: Record<string, unknown> = {}, name = 'NativePod') {
  return {
    target: name,
    buildSettings: {
      CONFIGURATION: 'Debug',
      PLATFORM_NAME: 'iphonesimulator',
      PRODUCT_TYPE: 'com.apple.product-type.library.static',
      ONLY_ACTIVE_ARCH: 'NO',
      ARCHS: 'arm64 x86_64',
      VALID_ARCHS: 'arm64 x86_64',
      ...settings,
    },
  };
}

test('resolved Pod overrides are detected even when the app builds only its active architecture', () => {
  const report = parseIosDebugArchitectures(
    JSON.stringify([
      target({ ONLY_ACTIVE_ARCH: 'YES', PRODUCT_TYPE: 'com.apple.product-type.application' }, 'App'),
      target(),
    ]),
  );
  expect(report).toEqual({ affected: [{ target: 'NativePod', architectures: ['arm64', 'x86_64'] }], unknown: false });
});

test.each([
  { ONLY_ACTIVE_ARCH: 'YES' },
  { ARCHS: 'arm64' },
  { ARCHS: 'arm64 arm64' },
  { EXCLUDED_ARCHS: 'x86_64' },
  { VALID_ARCHS: 'arm64' },
  { PRODUCT_TYPE: 'com.apple.product-type.bundle' },
])('single-architecture and non-compiling targets do not produce a cost warning: %j', (settings) => {
  expect(parseIosDebugArchitectures(JSON.stringify([target(settings)]))).toEqual({ affected: [], unknown: false });
});

test.each([
  { CONFIGURATION: 'Release' },
  { PLATFORM_NAME: 'iphoneos' },
  { ARCHS: '$(ARCHS_STANDARD)' },
  { EXCLUDED_ARCHS: '$(inherited)' },
  { ONLY_ACTIVE_ARCH: undefined },
  { PRODUCT_TYPE: undefined },
  { PRODUCT_TYPE: 'unknown-product' },
])('unexpected or unresolved settings remain unverified without false architecture warnings: %j', (settings) => {
  expect(parseIosDebugArchitectures(JSON.stringify([target(settings)]))).toEqual({ affected: [], unknown: true });
});

test.each(['not JSON', '[]', '[null]', '[{"target":"Pod","buildSettings":{},"error":"unavailable"}]'])(
  'unavailable metadata remains unverified: %s',
  (output) => {
    expect(parseIosDebugArchitectures(output)).toEqual({ affected: [], unknown: true });
  },
);

let home: string;
let project: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-doctor-architectures-'));
  process.env.STIM_HOME = join(home, 'state');
  project = join(home, 'app with spaces');
  mkdirSync(join(project, 'ios', 'App.xcodeproj'), { recursive: true });
});

afterEach(() => {
  resetExecutor();
  delete process.env.STIM_HOME;
  rmSync(home, { recursive: true, force: true });
});

test.skipIf(process.platform === 'win32')(
  'doctor reports generated Pod helper effects using bounded metadata calls without evaluating Ruby (xcodebuild metadata; skipped on win32)',
  async () => {
    mkdirSync(join(project, 'ios', 'Pods', 'Pods.xcodeproj'), { recursive: true });
    writeFileSync(
      join(project, 'ios', 'Podfile'),
      "require_relative '../helpers/pods'\npost_install { |installer| configure_pods(installer) }\n",
    );
    const calls: string[][] = [];
    setExecutor({
      async runFileAsync(file: string, args: string[], options: { timeoutMs: number }) {
        expect(file).toBe('xcodebuild');
        calls.push(args);
        expect(options.timeoutMs).toBeGreaterThan(0);
        expect(options.timeoutMs).toBeLessThanOrEqual(30_000);
        return JSON.stringify([target({ ONLY_ACTIVE_ARCH: args[1]?.includes('/Pods/') ? 'NO' : 'YES' })]);
      },
    });
    const findings = await inspectIosDebugArchitectures(project);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ code: 'ios-debug-architectures', level: 'cost' });
    expect(findings[0]?.detail).toContain('ios/Pods/Pods.xcodeproj');
    expect(findings[0]?.detail).toContain('NativePod (arm64, x86_64)');
    expect(calls).toHaveLength(2);
    for (const args of calls) {
      expect(args.slice(2)).toEqual([
        '-alltargets',
        '-configuration',
        'Debug',
        '-sdk',
        'iphonesimulator',
        '-showBuildSettings',
        '-json',
        '-disableAutomaticPackageResolution',
        '-skipPackageUpdates',
      ]);
    }
  },
);

test.skipIf(process.platform === 'win32')(
  'missing Pods and failed app metadata produce an unverified note without a cost warning (xcodebuild metadata; skipped on win32)',
  async () => {
    writeFileSync(join(project, 'ios', 'Podfile'), 'post_install {}\n');
    setExecutor({
      async runFileAsync() {
        throw new Error('timed out');
      },
    });
    const findings = await inspectIosDebugArchitectures(project);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ code: 'ios-debug-architectures-unknown', level: 'note' });
    expect(findings[0]?.detail).toContain('Pods project (not generated)');
    expect(findings[0]?.detail).toContain('ios/App.xcodeproj');
  },
);

test('ungenerated iOS projects do not invoke Xcode', async () => {
  setExecutor({
    async runFileAsync() {
      throw new Error('must not run');
    },
  });
  expect(await inspectIosDebugArchitectures(home)).toEqual([]);
});

test('metadata inspection stops at its total deadline and keeps partial findings', async () => {
  mkdirSync(join(project, 'ios', 'Pods', 'Pods.xcodeproj'), { recursive: true });
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000);
  let calls = 0;
  try {
    setExecutor({
      async runFileAsync() {
        calls++;
        clock.mockReturnValue(61_001);
        return JSON.stringify([target()]);
      },
    });
    expect((await inspectIosDebugArchitectures(project)).map((finding) => finding.code)).toEqual([
      'ios-debug-architectures',
      'ios-debug-architectures-unknown',
    ]);
    expect(calls).toBe(1);
  } finally {
    clock.mockRestore();
  }
});

test('a slow metadata child leaves the event loop responsive while preserving its findings', async () => {
  const executor = getExecutor();
  let finished = false;
  setExecutor({
    runFileAsync(_file, _args, options) {
      return executor.runFileAsync(
        process.execPath,
        ['-e', `setTimeout(() => console.log(${JSON.stringify(JSON.stringify([target()]))}), 200)`],
        options,
      );
    },
  });
  const inspection = inspectIosDebugArchitectures(project).then((findings) => {
    finished = true;
    return findings;
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  expect(finished).toBe(false);
  expect(await inspection).toEqual([expect.objectContaining({ code: 'ios-debug-architectures' })]);
});

test.skipIf(process.platform === 'win32')(
  'a repeated inspection reuses the result until a project input changes (xcodebuild metadata; skipped on win32)',
  async () => {
    const pbxproj = join(project, 'ios', 'App.xcodeproj', 'project.pbxproj');
    writeFileSync(pbxproj, 'one');
    let calls = 0;
    setExecutor({
      async runFileAsync() {
        calls++;
        return JSON.stringify([target({ ONLY_ACTIVE_ARCH: 'NO' })]);
      },
    });
    const first = await inspectIosDebugArchitectures(project);
    expect(first.map((finding) => finding.code)).toEqual(['ios-debug-architectures']);
    expect(await inspectIosDebugArchitectures(project)).toEqual(first);
    expect(calls).toBe(1);
    writeFileSync(pbxproj, 'changed');
    await inspectIosDebugArchitectures(project);
    expect(calls).toBe(2);
  },
);
