import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectIosDebugArchitectures, parseIosDebugArchitectures } from '../doctor-ios-architectures.ts';
import { resetExecutor, setExecutor } from '../exec.ts';

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

test('doctor reports generated Pod helper effects using bounded metadata calls without evaluating Ruby', () => {
  mkdirSync(join(project, 'ios', 'Pods', 'Pods.xcodeproj'), { recursive: true });
  writeFileSync(
    join(project, 'ios', 'Podfile'),
    "require_relative '../helpers/pods'\npost_install { |installer| configure_pods(installer) }\n",
  );
  const calls: string[][] = [];
  setExecutor({
    runFile(file: string, args: string[], options: { timeoutMs: number }) {
      expect(file).toBe('xcodebuild');
      calls.push(args);
      expect(options.timeoutMs).toBeGreaterThan(0);
      expect(options.timeoutMs).toBeLessThanOrEqual(30_000);
      return JSON.stringify([target({ ONLY_ACTIVE_ARCH: args[1]?.includes('/Pods/') ? 'NO' : 'YES' })]);
    },
  });
  const findings = inspectIosDebugArchitectures(project);
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
});

test('missing Pods and failed app metadata produce an unverified note without a cost warning', () => {
  writeFileSync(join(project, 'ios', 'Podfile'), 'post_install {}\n');
  setExecutor({
    runFile() {
      throw new Error('timed out');
    },
  });
  const findings = inspectIosDebugArchitectures(project);
  expect(findings).toHaveLength(1);
  expect(findings[0]).toMatchObject({ code: 'ios-debug-architectures-unknown', level: 'note' });
  expect(findings[0]?.detail).toContain('Pods project (not generated)');
  expect(findings[0]?.detail).toContain('ios/App.xcodeproj');
});

test('ungenerated iOS projects do not invoke Xcode', () => {
  setExecutor({
    runFile() {
      throw new Error('must not run');
    },
  });
  expect(inspectIosDebugArchitectures(home)).toEqual([]);
});

test('metadata inspection stops at its total deadline and keeps partial findings', () => {
  mkdirSync(join(project, 'ios', 'Pods', 'Pods.xcodeproj'), { recursive: true });
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000);
  let calls = 0;
  try {
    setExecutor({
      runFile() {
        calls++;
        clock.mockReturnValue(61_001);
        return JSON.stringify([target()]);
      },
    });
    expect(inspectIosDebugArchitectures(project).map((finding) => finding.code)).toEqual([
      'ios-debug-architectures',
      'ios-debug-architectures-unknown',
    ]);
    expect(calls).toBe(1);
  } finally {
    clock.mockRestore();
  }
});
