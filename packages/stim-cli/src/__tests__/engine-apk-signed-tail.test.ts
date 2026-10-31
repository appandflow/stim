import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { entryDir } from '../cache/build-cache.ts';
import { signedTailFor, signingBlockOffset, type RunApkTool } from '../engine/apk-signed-tail.ts';
import { signedApkBytes, writeSignedApk } from './_signed-apk.ts';

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
  test('a block whose two stored sizes disagree, or a ZIP64 end record, is not trusted', () => {
    const apk = signedApkBytes();
    const disagree = Buffer.from(apk.file);
    disagree.writeBigUInt64LE(1n, apk.tailOffset);
    expect(signingBlockOffset(disagree.length, reader(disagree))).toBe(null);
    const zip64 = Buffer.from(apk.file);
    zip64.writeUInt32LE(0xffffffff, zip64.length - 22 + 16);
    expect(signingBlockOffset(zip64.length, reader(zip64))).toBe(null);
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

  test('no apksigner means no tail', async () => {
    const path = entryApk();
    writeSignedApk(path, {}, false);
    expect(await signedTailFor(path, recordingRun().run, () => null)).toBe(null);
  });
});
