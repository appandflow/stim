import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
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
