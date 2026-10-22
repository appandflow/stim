import { createHash } from 'node:crypto';
import {
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { findBuildTool } from '../devices/android.ts';
import { sharedBuildCache } from '../workspace/paths.ts';

export const SIGNED_TAIL_FILE = 'apk-signed-tail.json';

const EOCD_SIGNATURE = 0x06054b50;
const EOCD_MIN_BYTES = 22;
const EOCD_SEARCH_BYTES = EOCD_MIN_BYTES + 0xffff;
const SIGNING_BLOCK_FOOTER_BYTES = 24;
const SIGNING_BLOCK_MAGIC = 'APK Sig Block 42';
const SIGNATURE_SCHEME_IDS = new Set([0x7109871a, 0xf05368c0]);
const SHA256_HEX = /^[0-9a-f]{64}$/;
const VERIFIED_V2_OR_V3 = /^Verified using v[23] scheme \(APK Signature Scheme v[23]\): true\s*$/m;

export interface SignedTail {
  file: string;
  size: number;
  tailOffset: number;
  tailSha256: string;
}

export type ApkRead = (position: number, length: number) => Buffer;

/**
 * The offset where an APK's v2 or v3 signing block starts, or null when the file has no such block, is ZIP64, or is
 * malformed. https://source.android.com/docs/security/features/apksigning/v2#apk-signing-block
 */
export function signingBlockOffset(size: number, read: ApkRead): number | null {
  if (size < EOCD_MIN_BYTES) return null;
  const searched = Math.min(size, EOCD_SEARCH_BYTES);
  const end = read(size - searched, searched);
  let eocd = -1;
  for (let i = end.length - EOCD_MIN_BYTES; i >= 0; i--) {
    if (end.readUInt32LE(i) === EOCD_SIGNATURE && i + EOCD_MIN_BYTES + end.readUInt16LE(i + 20) === end.length) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const directoryOffset = end.readUInt32LE(eocd + 16);
  if (directoryOffset === 0xffffffff || directoryOffset < SIGNING_BLOCK_FOOTER_BYTES + 8) return null;
  const footer = read(directoryOffset - SIGNING_BLOCK_FOOTER_BYTES, SIGNING_BLOCK_FOOTER_BYTES);
  if (footer.subarray(8).toString('latin1') !== SIGNING_BLOCK_MAGIC) return null;
  const blockSize = footer.readBigUInt64LE(0);
  if (blockSize < BigInt(SIGNING_BLOCK_FOOTER_BYTES) || blockSize + 8n > BigInt(directoryOffset)) return null;
  const start = directoryOffset - Number(blockSize) - 8;
  const pairs = read(start, Number(blockSize) + 8 - SIGNING_BLOCK_FOOTER_BYTES);
  if (pairs.readBigUInt64LE(0) !== blockSize) return null;
  let position = 8;
  while (position + 12 <= pairs.length) {
    const length = pairs.readBigUInt64LE(position);
    if (length < 4n || length > BigInt(pairs.length - position - 8)) return null;
    if (SIGNATURE_SCHEME_IDS.has(pairs.readUInt32LE(position + 8))) return start;
    position += 8 + Number(length);
  }
  return null;
}

function readSignedTail(apkPath: string): SignedTail | null {
  let fd: number | null = null;
  try {
    fd = openSync(apkPath, 'r');
    const open = fd;
    const size = fstatSync(open).size;
    const read: ApkRead = (position, length) => {
      const buffer = Buffer.alloc(length);
      if (readSync(open, buffer, 0, length, position) !== length) throw new Error('short read');
      return buffer;
    };
    const tailOffset = signingBlockOffset(size, read);
    if (tailOffset === null) return null;
    const tailSha256 = createHash('sha256')
      .update(read(tailOffset, size - tailOffset))
      .digest('hex');
    return { file: basename(apkPath), size, tailOffset, tailSha256 };
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
}

const apksignerPath = () => findBuildTool(['apksigner'])?.path ?? null;

export type RunApkTool = (file: string, args: string[]) => Promise<unknown>;

/**
 * Reads the APK's signed tail after `apksigner verify` shows its v2 or v3 signature covers the file's bytes. Null when
 * the APK has no such signature, apksigner is missing, or verification fails.
 */
export async function computeSignedTail(
  apkPath: string,
  run: RunApkTool,
  findSigner: () => string | null = apksignerPath,
): Promise<SignedTail | null> {
  const tail = readSignedTail(apkPath);
  if (!tail) return null;
  const signer = findSigner();
  if (!signer) return null;
  try {
    if (!VERIFIED_V2_OR_V3.test(String(await run(signer, ['verify', '--verbose', apkPath])))) return null;
  } catch {
    return null;
  }
  const after = readSignedTail(apkPath);
  return after && after.size === tail.size && after.tailSha256 === tail.tailSha256 ? tail : null;
}

export function recordedSignedTail(apkPath: string): SignedTail | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dirname(apkPath), SIGNED_TAIL_FILE), 'utf-8'));
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !('file' in parsed) ||
      !('size' in parsed) ||
      !('tailOffset' in parsed) ||
      !('tailSha256' in parsed)
    )
      return null;
    const { file, size, tailOffset, tailSha256 } = parsed;
    if (
      file !== basename(apkPath) ||
      typeof size !== 'number' ||
      typeof tailOffset !== 'number' ||
      typeof tailSha256 !== 'string' ||
      !SHA256_HEX.test(tailSha256) ||
      !Number.isSafeInteger(size) ||
      !Number.isSafeInteger(tailOffset) ||
      tailOffset < 0 ||
      tailOffset >= size ||
      statSync(apkPath).size !== size
    )
      return null;
    return { file, size, tailOffset, tailSha256 };
  } catch {
    return null;
  }
}

export async function writeSignedTail(dir: string, tail: SignedTail): Promise<void> {
  const target = join(dir, SIGNED_TAIL_FILE);
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(tail));
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function inBuildCacheEntry(apkPath: string): boolean {
  try {
    return realpathSync(dirname(dirname(apkPath))) === realpathSync(join(sharedBuildCache(), 'android'));
  } catch {
    return false;
  }
}

/**
 * The APK's recorded signed tail. A build cache entry stored without one gets it computed once and recorded; an APK
 * outside the build cache has none, so its callers compare whole files.
 */
export async function signedTailFor(
  apkPath: string,
  run: RunApkTool,
  findSigner?: () => string | null,
): Promise<SignedTail | null> {
  const recorded = recordedSignedTail(apkPath);
  if (recorded || !inBuildCacheEntry(apkPath)) return recorded;
  const computed = await computeSignedTail(apkPath, run, findSigner);
  if (!computed) return null;
  try {
    await writeSignedTail(dirname(apkPath), computed);
  } catch {}
  return computed;
}
