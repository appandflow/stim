import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { entryDir } from '../cache/build-cache.ts';
import {
  SIGNED_TAIL_FILE,
  recordedSignedTail,
  signedTailFor,
  signingBlockOffset,
  type RunApkTool,
} from '../engine/apk-signed-tail.ts';
import { V2_SCHEME_ID, V3_SCHEME_ID, VERITY_PADDING_ID, signedApkBytes, writeSignedApk } from './_signed-apk.ts';

const VERIFIED_V2 =
  'Verifies\nVerified using v1 scheme (JAR signing): false\nVerified using v2 scheme (APK Signature Scheme v2): true\n';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-signed-tail-'));
  process.env.STIM_HOME = home;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.STIM_HOME;
});

function reader(file: Buffer) {
  return (position: number, length: number) => {
    if (position < 0 || position + length > file.length) throw new Error('read past the end');
    return file.subarray(position, position + length);
  };
}

describe('signingBlockOffset', () => {
  test.each([
    ['v2', [V2_SCHEME_ID]],
    ['v3', [V3_SCHEME_ID]],
    ['v2 after the verity padding pair', [VERITY_PADDING_ID, V2_SCHEME_ID]],
  ])('finds where the %s signing block starts', (_label, ids) => {
    const apk = signedApkBytes({ ids });
    expect(signingBlockOffset(apk.size, reader(apk.file))).toBe(apk.tailOffset);
  });

  test('a ZIP comment that looks like an end record does not move the answer', () => {
    const apk = signedApkBytes({
      comment: 'PK\x05\x06 not the end record at all',
    });
    expect(signingBlockOffset(apk.size, reader(apk.file))).toBe(apk.tailOffset);
  });

  test.each([
    ['a block with no v2 or v3 pair', signedApkBytes({ ids: [VERITY_PADDING_ID] }).file],
    ['no signing block', Buffer.concat([Buffer.from('entries'), Buffer.alloc(22)])],
    ['a file shorter than an end record', Buffer.from('short')],
    ['a truncated file', signedApkBytes().file.subarray(0, 60)],
  ])('is null for %s, so callers compare whole files', (_label, file) => {
    expect(signingBlockOffset(file.length, reader(file))).toBe(null);
  });
});

describe('signedTailFor', () => {
  function entryApk(key = 'k1') {
    return join(entryDir('android', key), 'app-debug.apk');
  }

  function recordingRun(output = VERIFIED_V2) {
    const calls: string[][] = [];
    const run: RunApkTool = async (file, args) => {
      calls.push([file, ...args]);
      return output;
    };
    return { calls, run };
  }

  const signer = () => '/sdk/build-tools/36.0.0/apksigner';

  test('a cache entry without a recorded tail has it verified and recorded once, then read back', async () => {
    const path = entryApk();
    const apk = writeSignedApk(path, {}, false);
    const { calls, run } = recordingRun();

    const first = await signedTailFor(path, run, signer);
    const second = await signedTailFor(path, run, signer);

    expect(first).toEqual({
      file: 'app-debug.apk',
      size: apk.size,
      tailOffset: apk.tailOffset,
      tailSha256: apk.tailSha256,
    });
    expect(second).toEqual(first);
    expect(calls).toEqual([['/sdk/build-tools/36.0.0/apksigner', 'verify', '--verbose', path]]);
    expect(readdirSync(entryDir('android', 'k1')).toSorted()).toEqual([SIGNED_TAIL_FILE, 'app-debug.apk']);
  });

  test.each([
    [
      'apksigner reports no v2 or v3 signature',
      'Verifies\nVerified using v1 scheme (JAR signing): true\nVerified using v2 scheme (APK Signature Scheme v2): false\n',
    ],
    ['apksigner prints nothing', ''],
  ])('%s: nothing is recorded', async (_label, output) => {
    const path = entryApk();
    writeSignedApk(path, {}, false);
    expect(await signedTailFor(path, recordingRun(output).run, signer)).toBe(null);
    expect(readdirSync(entryDir('android', 'k1'))).toEqual(['app-debug.apk']);
  });

  test('apksigner output with Windows line endings is read the same way', async () => {
    const path = entryApk();
    writeSignedApk(path, {}, false);
    expect(await signedTailFor(path, recordingRun(VERIFIED_V2.replaceAll('\n', '\r\n')).run, signer)).not.toBe(null);
  });

  test('no apksigner means no tail', async () => {
    const path = entryApk();
    writeSignedApk(path, {}, false);
    expect(await signedTailFor(path, recordingRun().run, () => null)).toBe(null);
  });

  test('an APK outside the build cache is never verified or recorded', async () => {
    const path = join(home, 'project', 'app-debug.apk');
    writeSignedApk(path, {}, false);
    const { calls, run } = recordingRun();
    expect(await signedTailFor(path, run, signer)).toBe(null);
    expect(calls).toEqual([]);
    expect(readdirSync(join(home, 'project'))).toEqual(['app-debug.apk']);
  });

  test('a recorded tail is used where the APK lives and ignored once the file changes size', () => {
    const path = join(home, 'anywhere', 'app-debug.apk');
    const apk = writeSignedApk(path);
    expect(recordedSignedTail(path)?.tailSha256).toBe(apk.tailSha256);
    writeFileSync(path, Buffer.concat([apk.file, Buffer.from('x')]));
    expect(recordedSignedTail(path)).toBe(null);
  });

  test('a record that names another file is ignored', () => {
    const path = join(home, 'anywhere', 'app-debug.apk');
    writeSignedApk(path);
    const other = join(home, 'anywhere', 'other.apk');
    writeFileSync(other, readFileSync(path));
    expect(recordedSignedTail(other)).toBe(null);
  });
});
