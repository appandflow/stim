import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { gitAsync } from '../workspace/git.ts';
import { field } from './walk.ts';

const STAT_BYTES = 40;
const SHA1_BYTES = 20;
const EXTENDED = 0x4000;

/** git's offset varint (`decode_varint` in git's varint.c), as index v4 stores the bytes to strip from a name. */
function varint(data: Buffer, start: number): [value: number, next: number] | null {
  let pos = start;
  let byte = data[pos++];
  if (byte === undefined) return null;
  let value = byte & 127;
  while (byte & 128) {
    byte = data[pos++];
    if (byte === undefined) return null;
    value = ((value + 1) << 7) | (byte & 127);
  }
  return [value, pos];
}

/**
 * The paths of a sha1 repository's index file, versions 2 to 4, relative to the work tree top (gitformat-index(5)).
 * Null for anything else, including a split index (`link`) or a sparse index (`sdir`), whose entry list is not the
 * whole tracked set.
 */
export function parseGitIndex(data: Buffer): string[] | null {
  if (data.length < 12 + SHA1_BYTES || data.toString('latin1', 0, 4) !== 'DIRC') return null;
  const version = data.readUInt32BE(4);
  if (version < 2 || version > 4) return null;
  const count = data.readUInt32BE(8);
  const end = data.length - SHA1_BYTES;
  const paths: string[] = [];
  let previous: Buffer = Buffer.alloc(0);
  let pos = 12;
  for (let i = 0; i < count; i++) {
    const start = pos;
    pos += STAT_BYTES + SHA1_BYTES;
    if (pos + 2 > end) return null;
    const flags = data.readUInt16BE(pos);
    pos += 2;
    if (flags & EXTENDED) {
      if (version < 3) return null;
      pos += 2;
    }
    let name: Buffer;
    if (version === 4) {
      const strip = varint(data, pos);
      if (!strip || strip[0] > previous.length) return null;
      pos = strip[1];
      const nul = data.indexOf(0, pos);
      if (nul === -1 || nul >= end) return null;
      name = Buffer.concat([previous.subarray(0, previous.length - strip[0]), data.subarray(pos, nul)]);
      pos = nul + 1;
    } else {
      const nul = data.indexOf(0, pos);
      if (nul === -1 || nul >= end) return null;
      name = data.subarray(pos, nul);
      pos = start + ((nul - start + 8) & ~7);
    }
    if (name.length === 0) return null;
    previous = name;
    paths.push(name.toString('utf8'));
  }
  while (pos < end) {
    if (pos + 8 > end) return null;
    const signature = data[pos] ?? 0;
    if (signature < 0x41 || signature > 0x5a) return null;
    pos += 8 + data.readUInt32BE(pos + 4);
  }
  return pos === end ? [...new Set(paths)] : null;
}

function gitDirOf(dotGit: string): string | null {
  try {
    if (statSync(dotGit).isDirectory()) return dotGit;
    const match = /^gitdir: (.+)$/m.exec(readFileSync(dotGit, 'utf8'));
    return match?.[1] ? resolve(dirname(dotGit), match[1].trim()) : null;
  } catch {
    return null;
  }
}

function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

/** The work tree top above `root`, its git dir and the common dir its worktrees share, or null outside git. */
export function gitLocation(root: string): { top: string; gitDir: string; commonDir: string } | null {
  let top = realpathSync.native(root);
  while (statSync(join(top, '.git'), { throwIfNoEntry: false }) === undefined) {
    if (dirname(top) === top) return null;
    top = dirname(top);
  }
  const gitDir = gitDirOf(join(top, '.git'));
  if (!gitDir) return null;
  const common = readText(join(gitDir, 'commondir')).trim();
  return { top, gitDir, commonDir: common ? resolve(gitDir, common) : gitDir };
}

/**
 * The real paths git tracks in the work tree that holds `root`, or null when no work tree does. Reads
 * the index file in process, and runs `git ls-files` only for an index this reader does not handle.
 */
export async function trackedPaths(root: string, signal?: AbortSignal): Promise<Set<string> | null> {
  const location = gitLocation(root);
  if (!location) return null;
  const { top, gitDir, commonDir } = location;
  const config = readText(join(commonDir, 'config'));
  let paths: string[] | null = null;
  if (!/^\s*objectformat\s*=\s*sha256\s*$/im.test(config)) {
    let data: Buffer | null = null;
    try {
      data = readFileSync(join(gitDir, 'index'));
    } catch (error) {
      if (field(error, 'code') === 'ENOENT') paths = [];
    }
    if (data) paths = parseGitIndex(data);
  }
  paths ??= (await gitAsync(top, ['ls-files', '-z', '-c'], { untrimmed: true, timeoutMs: 60_000, signal }))
    .split('\0')
    .filter(Boolean);
  return new Set(paths.map((path) => join(top, path)));
}
