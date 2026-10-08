import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { iosToolchain } from '../offload/toolchain.ts';

let root: string;

function executable(bin: string, name: string, body: string): void {
  mkdirSync(bin, { recursive: true });
  const file = join(bin, name);
  writeFileSync(file, '#!' + process.execPath + '\n' + body + '\n');
  chmodSync(file, 0o755);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stim-pod-toolchain-'));
  const bin = join(root, 'bin');
  executable(bin, 'xcodebuild', "console.log(process.env.GEM_HOME ? 'Wrong Ruby environment' : 'Xcode 27.0');");
  executable(bin, 'xcrun', "console.log('27.0');");
  const pod = (version: string) =>
    "if (!process.env.LANG?.endsWith('UTF-8') || !process.env.LC_ALL?.endsWith('UTF-8')) process.exit(1); console.log(" +
    JSON.stringify(version) +
    ');';
  executable(bin, 'pod', pod('1.17.0'));
  executable(join(root, '.rvm', 'rubies', 'ruby-3.3.4', 'bin'), 'pod', pod('1.16.2'));
  mkdirSync(join(root, '.rvm', 'gems', 'ruby-3.3.4'), { recursive: true });
  vi.stubEnv('HOME', root);
  vi.stubEnv('PATH', bin + delimiter + process.env.PATH);
  vi.stubEnv('GEM_HOME', undefined);
  vi.stubEnv('GEM_PATH', undefined);
  vi.stubEnv('LANG', undefined);
  vi.stubEnv('LC_ALL', undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

test.skipIf(process.platform !== 'darwin')(
  'the CocoaPods comparison follows the project Ruby while Xcode keeps the machine environment',
  () => {
    writeFileSync(join(root, '.ruby-version'), 'ruby-3.3.4\n');
    expect(iosToolchain(root)).toMatchObject({
      cocoapods: '1.16.2',
      xcode: 'Xcode 27.0',
      simulatorSdk: '27.0',
    });
  },
);

test.skipIf(process.platform !== 'darwin')(
  'an unpinned or unavailable Ruby keeps the default CocoaPods with UTF-8 locale defaults',
  () => {
    expect(iosToolchain(root).cocoapods).toBe('1.17.0');
    writeFileSync(join(root, '.ruby-version'), '3.2.0\n');
    expect(iosToolchain(root).cocoapods).toBe('1.17.0');
  },
);
