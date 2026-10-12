import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testContext } from './_context.ts';
import { writeNativeXcodeProject } from './_native-xcode-project.ts';
import { nativeXcodeInputSnapshot } from '../integrations/native-xcode-inputs.ts';
import { selectNativeXcodeProject } from '../integrations/native-xcode-project.ts';

let scratch: string;
let root: string;

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'stim-xcode-input-context-')));
  root = join(scratch, 'app');
  mkdirSync(root);
  writeNativeXcodeProject(root);
});

afterEach(() => rmSync(scratch, { recursive: true, force: true }));

async function snapshot(env: NodeJS.ProcessEnv) {
  const context = testContext({ home: join(scratch, 'home'), env });
  await Promise.resolve();
  return nativeXcodeInputSnapshot(
    root,
    selectNativeXcodeProject(root),
    {
      sdk: 'iphonesimulator',
      architecture: 'arm64',
      toolchain: { xcode: 'Xcode 26.0 build 17A', sdk: '26.0' },
      optimizations: {},
    },
    context.env,
  );
}

test('concurrent operations fingerprint their own compiler flags without changing the host environment', async () => {
  const hostFlags = process.env.CFLAGS;
  const [alpha, beta] = await Promise.all([snapshot({ CFLAGS: '-DALPHA' }), snapshot({ CFLAGS: '-DBETA' })]);
  expect(alpha).toHaveProperty('hash');
  expect(beta).toHaveProperty('hash');
  expect(beta).not.toEqual(alpha);
  expect(await snapshot({ CFLAGS: '-DALPHA' })).toEqual(alpha);
  expect(process.env.CFLAGS).toBe(hostFlags);
});

test('a caller compiler override refuses reuse without contaminating another operation', async () => {
  const [overridden, ordinary] = await Promise.all([snapshot({ CC: '/client/clang' }), snapshot({})]);
  expect(overridden).toMatchObject({ cacheIneligible: expect.stringContaining('Environment CC') });
  expect(ordinary).toHaveProperty('hash');
});

test('caller configuration and include variables select the files that invalidate its cache', async () => {
  const config = join(scratch, 'Override.xcconfig');
  const alpha = join(scratch, 'Alpha.xcconfig');
  const beta = join(scratch, 'Beta.xcconfig');
  writeFileSync(config, '#include "$(CLIENT_CONFIG)"\n');
  writeFileSync(alpha, 'SWIFT_VERSION = 5.0\n');
  writeFileSync(beta, 'SWIFT_VERSION = 6.0\n');
  const env = { XCODE_XCCONFIG_FILE: config, CLIENT_CONFIG: alpha };
  const before = await snapshot(env);
  expect(before).toHaveProperty('hash');
  writeFileSync(beta, 'SWIFT_VERSION = 6.1\n');
  expect(await snapshot(env)).toEqual(before);
  writeFileSync(alpha, 'SWIFT_VERSION = 5.1\n');
  expect(await snapshot(env)).not.toEqual(before);
});

test('relative override configs resolve from the build directory while preserving the host cwd', async () => {
  const cwd = process.cwd();
  const config = join(root, 'Override.xcconfig');
  const included = join(scratch, 'Included.xcconfig');
  writeFileSync(config, '#include "../Included.xcconfig"\n');
  writeFileSync(included, 'SWIFT_VERSION = 5.0\n');
  const env = { XCODE_XCCONFIG_FILE: 'Override.xcconfig' };
  const before = await snapshot(env);
  expect(before).toHaveProperty('hash');
  writeFileSync(included, 'SWIFT_VERSION = 6.0\n');
  const after = await snapshot(env);
  expect(after).toHaveProperty('hash');
  expect(after).not.toEqual(before);
  expect(process.cwd()).toBe(cwd);
});
