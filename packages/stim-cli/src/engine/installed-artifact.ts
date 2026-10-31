import { createHash } from 'node:crypto';
import { closeSync, openSync, readSync, lstatSync, readdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { getExecutor, type Executor } from '../exec.ts';
import { signedTailFor, type SignedTail } from './apk-signed-tail.ts';

const READ_CHUNK_BYTES = 1024 * 1024;

const DEVICE_PATH_TIMEOUT_MS = 30000;

const DEVICE_HASH_TIMEOUT_MS = 120000;

const APKSIGNER_TIMEOUT_MS = 120000;

const PACKAGE_NAME = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+$/;

const EMPTY_INPUT_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

const SHA256_HEX = /^[0-9a-f]{64}$/;

function parseInstalledApkPath(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const paths: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('package:')) continue;
    const path = line.slice('package:'.length);
    if (path.startsWith('/')) paths.push(path);
  }
  return paths.length === 1 ? paths[0]! : null;
}

export function parseDeviceSha256(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const first = text.trim().split(/\s+/)[0] ?? '';
  return SHA256_HEX.test(first) ? first : null;
}

function deviceTailProbeScript(packageName: string, tailBytes: number): string {
  return (
    `for p in $(pm path ${packageName} | sed -n "s/^package://p"); do ` +
    `echo "path $p"; stat -c "size %s" "$p"; tail -c ${tailBytes} "$p" | sha256sum; done`
  );
}

type DeviceTailProbe = { installs: 0 | 'split' } | { installs: 1; size: number; tailSha256: string };

const TAIL_PROBE = /^path \/.*\nsize (\d+)\n(\S+) {2}-$/gm;

function parseDeviceTailProbe(text: unknown): DeviceTailProbe | null {
  if (typeof text !== 'string') return null;
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return { installs: 0 };
  const probes: { size: number; tailSha256: string }[] = [];
  for (const [, size, digest] of lines.join('\n').matchAll(TAIL_PROBE)) {
    const tailSha256 = parseDeviceSha256(digest);
    if (!size || !tailSha256 || tailSha256 === EMPTY_INPUT_SHA256) return null;
    probes.push({ size: Number(size), tailSha256 });
  }
  if (probes.length * 3 !== lines.length) return null;
  const [only, ...others] = probes;
  return only && others.length === 0 ? { installs: 1, ...only } : { installs: 'split' };
}

export function parseAppContainerPath(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length === 1 && isAbsolute(lines[0]!) ? lines[0]! : null;
}

function artifactsMatch(local: string | null, installed: string | null): boolean {
  return Boolean(local) && local === installed;
}

export function hashFile(file: string): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(file, 'r');
    const digest = createHash('sha256');
    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    for (;;) {
      const read = readSync(fd, buffer, 0, READ_CHUNK_BYTES, null);
      if (read <= 0) break;
      digest.update(buffer.subarray(0, read));
    }
    return digest.digest('hex');
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

export function hashBundle(dir: string): string | null {
  const digest = createHash('sha256');
  const walk = (abs: string, rel: string): boolean => {
    let names: string[];
    try {
      names = readdirSync(abs);
    } catch {
      return false;
    }
    for (const name of names.toSorted()) {
      const child = join(abs, name);
      const path = rel === '' ? name : `${rel}/${name}`;
      let stat;
      try {
        stat = lstatSync(child);
      } catch {
        return false;
      }
      if (stat.isDirectory()) {
        if (!walk(child, path)) return false;
        continue;
      }
      if (!stat.isFile()) return false;
      const file = hashFile(child);
      if (file === null) return false;
      digest.update(`${path}\0${file}\n`);
    }
    return true;
  };
  return walk(dir, '') ? digest.digest('hex') : null;
}

async function deviceHoldsSignedTail(
  { serial, packageName }: { serial: string; packageName: string },
  tail: SignedTail,
  e: Executor,
): Promise<boolean | null> {
  let probe: DeviceTailProbe | null;
  try {
    probe = parseDeviceTailProbe(
      await e.runFileAsync(
        'adb',
        ['-s', serial, 'shell', deviceTailProbeScript(packageName, tail.size - tail.tailOffset)],
        {
          timeoutMs: DEVICE_PATH_TIMEOUT_MS,
        },
      ),
    );
  } catch {
    return false;
  }
  if (!probe) return null;
  if (probe.installs !== 1) return false;
  return probe.size === tail.size && probe.tailSha256 === tail.tailSha256;
}

export async function deviceHoldsApk(
  { serial, packageName, apkPath }: { serial: string; packageName: string; apkPath: string },
  { exec = null }: { exec?: Executor | null } = {},
): Promise<boolean> {
  const e = exec || getExecutor();
  const tail = PACKAGE_NAME.test(packageName)
    ? await signedTailFor(apkPath, (file, args) => e.runFileAsync(file, args, { timeoutMs: APKSIGNER_TIMEOUT_MS }))
    : null;
  if (tail) {
    const held = await deviceHoldsSignedTail({ serial, packageName }, tail, e);
    if (held !== null) return held;
  }
  let path: string | null;
  try {
    path = parseInstalledApkPath(
      await e.runFileAsync('adb', ['-s', serial, 'shell', 'pm', 'path', packageName], {
        timeoutMs: DEVICE_PATH_TIMEOUT_MS,
      }),
    );
  } catch {
    return false;
  }
  if (!path) return false;
  let installed: string | null;
  try {
    installed = parseDeviceSha256(
      await e.runFileAsync('adb', ['-s', serial, 'shell', 'sha256sum', path], { timeoutMs: DEVICE_HASH_TIMEOUT_MS }),
    );
  } catch {
    return false;
  }
  if (!installed) return false;
  return artifactsMatch(hashFile(apkPath), installed);
}

export async function deviceHoldsBundle(
  { udid, bundleId, appPath }: { udid: string; bundleId: string; appPath: string },
  { exec = null }: { exec?: Executor | null } = {},
): Promise<boolean> {
  const e = exec || getExecutor();
  let container: string | null;
  try {
    container = parseAppContainerPath(
      await e.runFileAsync('xcrun', ['simctl', 'get_app_container', udid, bundleId], {
        timeoutMs: DEVICE_PATH_TIMEOUT_MS,
      }),
    );
  } catch {
    return false;
  }
  if (!container) return false;
  const installed = hashBundle(container);
  if (!installed) return false;
  return artifactsMatch(hashBundle(appPath), installed);
}
