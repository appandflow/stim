import { mkdirSync, rmSync, statfsSync, unlinkSync, existsSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const FLOOR_BYTES = 2 * GIB;

export const gib = (bytes) => bytes / GIB;

function freeBytesOf(path) {
  const stat = statfsSync(path);
  return stat.bavail * stat.bsize;
}

// Real zero bytes, not a sparse file: a sparse file would not move the volume's free space.
export function createBallast({
  dir,
  free = () => freeBytesOf(dir),
  chunkBytes = 256 * MIB,
  floorBytes = FLOOR_BYTES,
}) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'ballast.bin');
  let written = 0;
  let handle = null;
  const zeros = Buffer.alloc(Math.min(chunkBytes, 64 * MIB));

  async function append(bytes) {
    handle ??= await open(file, 'a');
    let left = bytes;
    while (left > 0) {
      const size = Math.min(left, zeros.length);
      await handle.write(zeros, 0, size);
      left -= size;
      written += size;
    }
  }

  return {
    file,
    get bytes() {
      return written;
    },
    free,
    async stepTo(targetBytes, signal) {
      const target = Math.max(targetBytes, floorBytes);
      const before = free();
      let remaining = before - target;
      while (remaining > 0) {
        if (signal?.aborted) break;
        await append(Math.min(remaining, chunkBytes));
        remaining = free() - target;
      }
      await handle?.sync();
      return { before, after: free(), ballastBytes: written, clamped: target !== targetBytes };
    },
    async release() {
      await handle?.close();
      handle = null;
      if (existsSync(file)) unlinkSync(file);
      written = 0;
    },
    remove() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
