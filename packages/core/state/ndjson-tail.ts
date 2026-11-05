import { closeSync, fstatSync, openSync, readSync, statSync } from 'node:fs';
import { rotatedLogPath } from '../index.ts';
import { parseNdjsonText, type NdjsonRecord } from './ndjson.ts';

interface Generation {
  path: string;
  id: string | null;
  offset: number;
  head: Buffer;
  records: NdjsonRecord[];
}

const HEAD_BYTES = 64;

function generation(path: string): Generation {
  return { path, id: null, offset: 0, head: Buffer.alloc(0), records: [] };
}

function reset(gen: Generation): void {
  gen.id = null;
  gen.offset = 0;
  gen.head = Buffer.alloc(0);
  gen.records = [];
}

function fileId(stats: { dev: number | bigint; ino: number | bigint }): string {
  return `${stats.dev}:${stats.ino}`;
}

function readAt(fd: number, length: number, position: number): Buffer {
  const buffer = Buffer.allocUnsafe(length);
  let filled = 0;
  while (filled < length) {
    const n = readSync(fd, buffer, filled, length - filled, position + filled);
    if (n === 0) break;
    filled += n;
  }
  return buffer.subarray(0, filled);
}

function advance(gen: Generation): boolean {
  let fd: number;
  try {
    fd = openSync(gen.path, 'r');
  } catch {
    const had = gen.id !== null;
    reset(gen);
    return had;
  }
  try {
    const stats = fstatSync(fd, { bigint: true });
    const id = fileId(stats);
    const size = Number(stats.size);
    let changed = false;
    // A file system can hand a deleted file's inode number to a new file, so an unchanged id is also checked
    // against the first bytes already read.
    if (
      gen.id !== id ||
      size < gen.offset ||
      (gen.head.length > 0 && !readAt(fd, gen.head.length, 0).equals(gen.head))
    ) {
      changed = gen.id !== null || gen.records.length > 0;
      reset(gen);
      gen.id = id;
    }
    const length = size - gen.offset;
    if (length <= 0) return changed;
    const buffer = readAt(fd, length, gen.offset);
    const end = buffer.lastIndexOf(0x0a);
    if (end < 0) return changed;
    const added = parseNdjsonText(buffer.toString('utf-8', 0, end + 1));
    for (const record of added) gen.records.push(record);
    if (gen.head.length < HEAD_BYTES) {
      const grown = Buffer.concat([gen.head, buffer.subarray(0, end + 1)]);
      gen.head = grown.subarray(0, HEAD_BYTES);
    }
    gen.offset += end + 1;
    return changed || added.length > 0;
  } finally {
    closeSync(fd);
  }
}

function statId(path: string): string | null {
  try {
    return fileId(statSync(path, { bigint: true }));
  } catch {
    return null;
  }
}

/**
 * Returns a reader of `file` and its rotated generation that yields, on every call, the records a full
 * `readNdjsonGenerations(file)` would, while reading only the bytes appended since the previous call. A file renamed
 * to its rotated generation between two calls is finished from there; any other replacement or a shrunk file is
 * read again from its start. A file rewritten in place to at least its previous length is not detected.
 */
export function createNdjsonTail(file: string): () => NdjsonRecord[] {
  const rotated = generation(rotatedLogPath(file));
  const current = generation(file);
  let all: NdjsonRecord[] = [];
  return () => {
    let changed = false;
    if (current.id !== null && statId(file) !== current.id && statId(rotated.path) === current.id) {
      rotated.id = current.id;
      rotated.offset = current.offset;
      rotated.head = current.head;
      rotated.records = current.records;
      reset(current);
      changed = true;
    }
    changed = advance(rotated) || changed;
    changed = advance(current) || changed;
    if (changed) all = rotated.records.concat(current.records);
    return all;
  };
}
