import { createHash } from 'node:crypto';

/** The stat data of one index entry, each field as the unsigned 32-bit value git stores. */
export interface IndexStat {
  ctimeSec: number;
  ctimeNsec: number;
  mtimeSec: number;
  mtimeNsec: number;
  dev: number;
  ino: number;
  uid: number;
  gid: number;
  size: number;
}

export interface IndexEntry {
  /** Where the entry starts in the index bytes. */
  offset: number;
  path: Buffer;
  mode: number;
  stat: IndexStat;
  /** The entry's object name, in hexadecimal. */
  oid: string;
  emptyBlob: boolean;
  stage: number;
  assumeUnchanged: boolean;
  skipWorktree: boolean;
  intentToAdd: boolean;
}

export interface ParsedIndex {
  entries: IndexEntry[];
  entriesEnd: number;
  extensions: { signature: string; start: number; end: number }[];
}

/** What `lstat` with `bigint: true` returns, as far as an index entry records it. */
export interface FileStat {
  mode: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  dev: bigint;
  ino: bigint;
  uid: bigint;
  gid: bigint;
}

const HASH_BYTES = 20;
const EMPTY_BLOB = Buffer.from('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391', 'hex');
const FILE_TYPE = 0o170000;
const REGULAR = 0o100000;
const SYMLINK = 0o120000;

function sha1(bytes: Buffer): Buffer {
  return createHash('sha1').update(bytes).digest();
}

/**
 * Reads a SHA-1 git index of version 2, 3 or 4, or returns null for anything else: another version, a checksum
 * that does not match, or bytes that do not parse to the end.
 */
export function readIndex(bytes: Buffer): ParsedIndex | null {
  // gitformat-index(5): a 12-byte header, the entries, the extensions, then a checksum of everything before it,
  // which is all zero when index.skipHash wrote the file.
  if (bytes.length < 12 + HASH_BYTES || bytes.toString('latin1', 0, 4) !== 'DIRC') return null;
  const version = bytes.readUInt32BE(4);
  if (version < 2 || version > 4) return null;
  const end = bytes.length - HASH_BYTES;
  const trailer = bytes.subarray(end);
  if (trailer.some((byte) => byte !== 0) && !trailer.equals(sha1(bytes.subarray(0, end)))) return null;
  const count = bytes.readUInt32BE(8);
  const entries: IndexEntry[] = [];
  let at = 12;
  let previous: Buffer = Buffer.alloc(0);
  for (let n = 0; n < count; n++) {
    if (at + 64 > end) return null;
    const flags = bytes.readUInt16BE(at + 60);
    const extended = flags & 0x4000 ? bytes.readUInt16BE(at + 62) : 0;
    if (flags & 0x4000 && version < 3) return null;
    let name = at + (flags & 0x4000 ? 64 : 62);
    let path: Buffer;
    let next: number;
    if (version === 4) {
      // gitformat-index(5): a version 4 name is the number of bytes to drop from the previous name, in the offset
      // encoding of pack files, then the bytes to append and a NUL.
      let byte = bytes.readUInt8(name++);
      let strip = byte & 0x7f;
      while (byte & 0x80) {
        if (name >= end) return null;
        byte = bytes.readUInt8(name++);
        strip = ((strip + 1) << 7) + (byte & 0x7f);
      }
      const nul = bytes.indexOf(0, name);
      if (nul < 0 || nul >= end || strip > previous.length) return null;
      path = Buffer.concat([previous.subarray(0, previous.length - strip), bytes.subarray(name, nul)]);
      next = nul + 1;
    } else {
      const nul = bytes.indexOf(0, name);
      if (nul < 0 || nul >= end) return null;
      path = bytes.subarray(name, nul);
      // gitformat-index(5): 1 to 8 NUL bytes pad a version 2 or 3 entry to a multiple of 8 bytes.
      next = at + ((nul - at + 8) & ~7);
    }
    if (next > end || !path.length) return null;
    previous = path;
    entries.push({
      offset: at,
      path,
      mode: bytes.readUInt32BE(at + 24),
      stat: {
        ctimeSec: bytes.readUInt32BE(at),
        ctimeNsec: bytes.readUInt32BE(at + 4),
        mtimeSec: bytes.readUInt32BE(at + 8),
        mtimeNsec: bytes.readUInt32BE(at + 12),
        dev: bytes.readUInt32BE(at + 16),
        ino: bytes.readUInt32BE(at + 20),
        uid: bytes.readUInt32BE(at + 28),
        gid: bytes.readUInt32BE(at + 32),
        size: bytes.readUInt32BE(at + 36),
      },
      oid: bytes.toString('hex', at + 40, at + 60),
      emptyBlob: bytes.subarray(at + 40, at + 60).equals(EMPTY_BLOB),
      stage: (flags >> 12) & 3,
      assumeUnchanged: (flags & 0x8000) !== 0,
      skipWorktree: (extended & 0x4000) !== 0,
      intentToAdd: (extended & 0x2000) !== 0,
    });
    at = next;
  }
  const entriesEnd = at;
  const extensions: ParsedIndex['extensions'] = [];
  while (at < end) {
    if (at + 8 > end) return null;
    const next = at + 8 + bytes.readUInt32BE(at + 4);
    if (next > end) return null;
    extensions.push({ signature: bytes.toString('latin1', at, at + 4), start: at, end: next });
    at = next;
  }
  return { entries, entriesEnd, extensions };
}

/**
 * The index `bytes` with the stat data of entry `n` replaced by `stats[n]`, or zeroed where that is null, which is
 * how `git read-tree` leaves an entry git has not compared with its file. Only the extensions `keep` accepts are
 * written. The checksum stays all zero when the source's was.
 */
export function writeIndex(
  bytes: Buffer,
  index: ParsedIndex,
  stats: readonly (IndexStat | null)[],
  keep: (signature: string) => boolean,
): Buffer {
  const entries = Buffer.from(bytes.subarray(0, index.entriesEnd));
  index.entries.forEach(({ offset }, n) => {
    const stat = stats[n];
    const fields: [number, number][] = [
      [0, stat?.ctimeSec ?? 0],
      [4, stat?.ctimeNsec ?? 0],
      [8, stat?.mtimeSec ?? 0],
      [12, stat?.mtimeNsec ?? 0],
      [16, stat?.dev ?? 0],
      [20, stat?.ino ?? 0],
      [28, stat?.uid ?? 0],
      [32, stat?.gid ?? 0],
      [36, stat?.size ?? 0],
    ];
    for (const [at, value] of fields) entries.writeUInt32BE(value, offset + at);
  });
  const body = Buffer.concat([
    entries,
    ...index.extensions.filter(({ signature }) => keep(signature)).map(({ start, end }) => bytes.subarray(start, end)),
  ]);
  const skipHash = bytes.subarray(bytes.length - HASH_BYTES).every((byte) => byte === 0);
  return Buffer.concat([body, skipHash ? Buffer.alloc(HASH_BYTES) : sha1(body)]);
}

function u32(value: bigint): number {
  return Number(BigInt.asUintN(32, value));
}

/**
 * The stat data to record for `clone`, a clonefile(2) copy of `source`, or null when git has to read the file.
 * `source` is the file the entry describes, looked at after the clone was made: when it still matches the entry by
 * the test `git status` runs, it has not changed since git recorded the entry, so the clone holds the entry's blob.
 */
export function cloneStat(
  entry: IndexEntry,
  source: FileStat | null,
  clone: FileStat | null,
  /** The modification time, in seconds, of the index file the entry was read from. */
  indexMtimeSec: number,
): IndexStat | null {
  if (!source || !clone) return null;
  if (entry.stage || entry.assumeUnchanged || entry.skipWorktree || entry.intentToAdd) return null;
  const type = entry.mode & FILE_TYPE;
  if (type !== REGULAR && type !== SYMLINK) return null;
  const mode = Number(source.mode);
  if ((mode & FILE_TYPE) !== type) return null;
  if (type === REGULAR && (mode ^ entry.mode) & 0o100) return null;
  const recorded = entry.stat;
  // git statinfo.c match_stat_data: the device is compared only in a git built with USE_STDEV, so an index keeps the
  // number a volume had when the entry was written.
  const seen = statOf(source);
  if (
    recorded.ctimeSec !== seen.ctimeSec ||
    recorded.ctimeNsec !== seen.ctimeNsec ||
    recorded.mtimeSec !== seen.mtimeSec ||
    recorded.mtimeNsec !== seen.mtimeNsec ||
    recorded.ino !== seen.ino ||
    recorded.uid !== seen.uid ||
    recorded.gid !== seen.gid ||
    recorded.size !== seen.size
  )
    return null;
  // git read-cache.c ce_match_stat_basic: writing the index sets the size of a changed entry it could not tell
  // apart by time to 0, so a recorded size of 0 means unchanged only for the empty blob.
  if (!recorded.size && !entry.emptyBlob) return null;
  // git read-cache.c is_racy_stat: an entry modified in the second its index was written, or later, can hide a
  // change that kept the size, so git compares its content.
  if (recorded.mtimeSec >= indexMtimeSec) return null;
  if (clone.mode !== source.mode || clone.size !== source.size || clone.mtimeNs !== source.mtimeNs) return null;
  return statOf(clone);
}

function statOf(stat: FileStat): IndexStat {
  return {
    ctimeSec: u32(stat.ctimeNs / 1_000_000_000n),
    ctimeNsec: u32(stat.ctimeNs % 1_000_000_000n),
    mtimeSec: u32(stat.mtimeNs / 1_000_000_000n),
    mtimeNsec: u32(stat.mtimeNs % 1_000_000_000n),
    dev: u32(stat.dev),
    ino: u32(stat.ino),
    uid: u32(stat.uid),
    gid: u32(stat.gid),
    size: u32(stat.size),
  };
}
