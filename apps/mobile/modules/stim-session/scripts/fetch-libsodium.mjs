#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDir = fileURLToPath(new URL('..', import.meta.url));
const pin = JSON.parse(readFileSync(join(moduleDir, 'libsodium.json'), 'utf8'));

/** The extracted sources: `src` is the release's `src/libsodium`, with `builds/msvc/version.h` as `include/sodium/version.h`. */
export const libsodiumDir = join(moduleDir, 'third_party/libsodium');
const stampFile = join(libsodiumDir, '.sha256');

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const current = () => existsSync(stampFile) && readFileSync(stampFile, 'utf8').trim() === pin.sha256;

/** The per-user cache that keeps verified tarballs, so worktrees and clean builds download each release once. */
function cacheDir() {
  if (process.env.STIM_SESSION_CACHE_DIR) return process.env.STIM_SESSION_CACHE_DIR;
  if (process.platform === 'darwin') return join(homedir(), 'Library/Caches/stim-session');
  if (process.platform === 'win32' && process.env.LOCALAPPDATA)
    return join(process.env.LOCALAPPDATA, 'stim-session/Cache');
  return join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'stim-session');
}

function verified(bytes, from) {
  const actual = sha256(bytes);
  if (actual !== pin.sha256) {
    throw new Error(`libsodium ${pin.version} from ${from} has SHA-256 ${actual}, not the pinned ${pin.sha256}.`);
  }
  return bytes;
}

/**
 * The path of the pinned tarball, checked against its SHA-256: `STIM_LIBSODIUM_TARBALL` for an offline build, else
 * the per-user cache, else a download from each pinned URL in turn, which then fills the cache.
 */
async function tarball() {
  const local = process.env.STIM_LIBSODIUM_TARBALL;
  if (local) {
    verified(readFileSync(local), local);
    return local;
  }
  const dir = cacheDir();
  const cached = join(dir, `libsodium-${pin.sha256}.tar.gz`);
  if (existsSync(cached)) {
    if (sha256(readFileSync(cached)) === pin.sha256) return cached;
    rmSync(cached, { force: true });
  }
  const attempts = [];
  for (const url of pin.urls) {
    let bytes;
    try {
      const response = await fetch(url, { redirect: 'follow' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      bytes = Buffer.from(await response.arrayBuffer());
    } catch (error) {
      attempts.push(`${url}: ${error.message}`);
      continue;
    }
    verified(bytes, url);
    mkdirSync(dir, { recursive: true });
    const partial = `${cached}.${process.pid}.tmp`;
    writeFileSync(partial, bytes);
    renameSync(partial, cached);
    return cached;
  }
  throw new Error(`Could not download libsodium ${pin.version}:\n  ${attempts.join('\n  ')}`);
}

/**
 * Makes `libsodiumDir` hold the sources of the libsodium release `libsodium.json` pins, downloading and checking its
 * SHA-256 unless the folder already holds that release. Nothing in the tarball runs; the builds only compile its C.
 */
export async function fetchLibsodium() {
  if (current()) return libsodiumDir;
  const archive = await tarball();
  mkdirSync(join(moduleDir, 'third_party'), { recursive: true });
  const work = mkdtempSync(join(moduleDir, 'third_party/.libsodium-'));
  try {
    const root = `libsodium-${pin.version}`;
    execFileSync('tar', [
      '-xzf',
      archive,
      '-C',
      work,
      `${root}/src/libsodium`,
      `${root}/builds/msvc/version.h`,
      `${root}/LICENSE`,
    ]);
    const out = join(work, 'libsodium');
    mkdirSync(out);
    renameSync(join(work, root, 'src/libsodium'), join(out, 'src'));
    // Only the C sources and headers: the builds compile nothing else, such as the x86 assembly or Makefiles.
    for (const file of readdirSync(join(out, 'src'), { recursive: true, withFileTypes: true })) {
      if (file.isFile() && !/\.[ch]$/.test(file.name)) rmSync(join(file.parentPath, file.name));
    }
    copyFileSync(join(work, root, 'builds/msvc/version.h'), join(out, 'src/include/sodium/version.h'));
    copyFileSync(join(work, root, 'LICENSE'), join(out, 'LICENSE'));
    writeFileSync(join(out, '.sha256'), `${pin.sha256}\n`);
    rmSync(libsodiumDir, { recursive: true, force: true });
    try {
      renameSync(out, libsodiumDir);
    } catch (error) {
      // Another build, such as a CMake configure for another ABI, extracted the same release first.
      if (!current()) throw error;
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return libsodiumDir;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  fetchLibsodium().then(
    (dir) => console.log(`libsodium ${pin.version} in ${dir}`),
    (error) => {
      console.error(`fetch-libsodium: ${error.message}`);
      process.exit(1);
    },
  );
}
