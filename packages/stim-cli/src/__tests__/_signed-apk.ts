import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { SIGNED_TAIL_FILE } from '../engine/apk-signed-tail.ts';

export const V2_SCHEME_ID = 0x7109871a;
export const V3_SCHEME_ID = 0xf05368c0;
export const VERITY_PADDING_ID = 0x42726577;

export interface SignedApk {
  file: Buffer;
  size: number;
  tailOffset: number;
  tailSha256: string;
}

export function signedApkBytes({
  ids = [V2_SCHEME_ID],
  entries = 'entry bytes '.repeat(200),
  comment = '',
  signature = 'signature bytes',
}: { ids?: number[]; entries?: string; comment?: string; signature?: string } = {}): SignedApk {
  const value = Buffer.from(signature);
  const pairs = Buffer.concat(
    ids.map((id) => {
      const pair = Buffer.alloc(12 + value.length);
      pair.writeBigUInt64LE(BigInt(4 + value.length), 0);
      pair.writeUInt32LE(id, 8);
      value.copy(pair, 12);
      return pair;
    }),
  );
  const size = Buffer.alloc(8);
  size.writeBigUInt64LE(BigInt(pairs.length + 24));
  const block = Buffer.concat([size, pairs, size, Buffer.from('APK Sig Block 42')]);
  const body = Buffer.from(entries);
  const directory = Buffer.from('central directory '.repeat(5));
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(body.length + block.length, 16);
  end.writeUInt16LE(comment.length, 20);
  const file = Buffer.concat([body, block, directory, end, Buffer.from(comment)]);
  const tailOffset = body.length;
  return {
    file,
    size: file.length,
    tailOffset,
    tailSha256: createHash('sha256').update(file.subarray(tailOffset)).digest('hex'),
  };
}

export function writeSignedApk(
  path: string,
  options: Parameters<typeof signedApkBytes>[0] = {},
  recorded = true,
): SignedApk {
  const apk = signedApkBytes(options);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, apk.file);
  if (recorded) {
    const name = path.slice(dirname(path).length + 1);
    writeFileSync(
      join(dirname(path), SIGNED_TAIL_FILE),
      JSON.stringify({
        file: name,
        size: apk.size,
        tailOffset: apk.tailOffset,
        tailSha256: apk.tailSha256,
      }),
    );
  }
  return apk;
}
