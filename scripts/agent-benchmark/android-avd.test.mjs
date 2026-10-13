import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { benchmarkAvdDescription } from './android-avd.mjs';
import { matchesExpectedAndroidEmulator } from './watch-app-selection.mjs';

let root;
let previousHome;
const name = 'Trailhead_run-1';
const image = 'system-images;android-36;google_apis_playstore_ps16k;arm64-v8a';
function fixture(home) {
  const directory = join(home, `${name}.avd`);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(home, `${name}.ini`), `path=${directory}\n`);
  writeFileSync(
    join(directory, 'config.ini'),
    'hw.device.name=pixel_6\nimage.sysdir.1=system-images/android-36/google_apis_playstore_ps16k/arm64-v8a/\ndisk.dataPartition.size=6G\ndisk.dataPartition.size=8G\n',
  );
  return directory;
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stim-avd-path-'));
  previousHome = process.env.ANDROID_AVD_HOME;
  process.env.ANDROID_AVD_HOME = join(root, 'default');
  mkdirSync(process.env.ANDROID_AVD_HOME);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.ANDROID_AVD_HOME;
  else process.env.ANDROID_AVD_HOME = previousHome;
});
it('identifies a run-local AVD from console output even with a different default home', () => {
  const run = join(root, 'run');
  const home = join(run, 'tmp', 'home with spaces');
  const directory = fixture(home);
  const avd = benchmarkAvdDescription(name, { reportedPath: `${directory}\r\nOK\r\n`, allowedRoots: [run] });
  expect(avd.avdHome).toBe(home);
  expect(avd.config['disk.dataPartition.size']).toBe('8G');
  expect(
    matchesExpectedAndroidEmulator(avd, {
      name,
      deviceTypeIdentifier: 'pixel_6',
      runtimeIdentifier: 'Android-36',
      systemImage: image,
    }),
  ).toBe(true);
  expect(
    matchesExpectedAndroidEmulator(avd, {
      name,
      deviceTypeIdentifier: 'pixel_7',
      runtimeIdentifier: 'Android-36',
      systemImage: image,
    }),
  ).toBe(false);
  expect(benchmarkAvdDescription(name, { reportedPath: directory, allowedRoots: [run] })).toEqual(avd);
});
it('retains default-home inspection and leaves missing configurations unknown', () => {
  expect(benchmarkAvdDescription(name)).toEqual({ name, config: {} });
  fixture(process.env.ANDROID_AVD_HOME);
  expect(benchmarkAvdDescription(name).systemImage).toBe(image);
});
it('refuses paths outside allowed roots and similarly prefixed sibling directories', () => {
  const directory = fixture(join(root, 'run-other'));
  mkdirSync(join(root, 'run'));
  expect(() => benchmarkAvdDescription(name, { reportedPath: directory, allowedRoots: [join(root, 'run')] })).toThrow(
    'outside',
  );
});
it('refuses symlink escape through the AVD directory', () => {
  const outside = fixture(join(root, 'outside'));
  const run = join(root, 'run');
  mkdirSync(run);
  const link = join(run, `${name}.avd`);
  symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  expect(() => benchmarkAvdDescription(name, { reportedPath: link, allowedRoots: [run] })).toThrow('outside');
});
it.each([
  '',
  'NO_AVD_INFO\nOK',
  'KO: unavailable',
  '/other.avd\nOK',
  '../Trailhead_run-1.avd',
  '/Trailhead_run-1.avd\n/unexpected',
])('refuses unavailable or ambiguous console output %s', (reportedPath) => {
  expect(() => benchmarkAvdDescription(name, { reportedPath, allowedRoots: [root] })).toThrow(
    'Unverified benchmark AVD path',
  );
});
it('refuses traversal names and missing reported configurations', () => {
  expect(() => benchmarkAvdDescription('../escape')).toThrow('name');
  expect(() =>
    benchmarkAvdDescription(name, { reportedPath: join(root, `${name}.avd`), allowedRoots: [root] }),
  ).toThrow('unavailable');
});

it('refuses a name index pointing at a different AVD before selecting its cleanup home', () => {
  const home = join(root, 'run');
  const directory = fixture(home);
  writeFileSync(join(home, `${name}.ini`), `path=${root}\n`);
  expect(() => benchmarkAvdDescription(name, { reportedPath: directory, allowedRoots: [root] })).toThrow('index');
});
