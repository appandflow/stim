import { lstatSync, readdirSync, readlinkSync, statSync } from 'fs';
import { dirname, isAbsolute, join, normalize, parse, sep } from 'path';
import { getExecutor } from './exec.ts';

const WINDOWS = process.platform === 'win32';
const DRIVE_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export function volumeRootFor(path: string): string {
  const normalized = normalize(String(path));
  if (WINDOWS) return parse(normalized).root.replace(/^[a-z]:/, (drive) => drive.toUpperCase());
  const m = normalized.match(/^\/volumes\/([^/]+)/i);
  return m ? `/Volumes/${m[1]}` : '/';
}

function resolveWorkspaceRealish(workspacePath: string): string | null {
  const raw = String(workspacePath);
  if (!isAbsolute(raw)) return null;
  let current = raw;
  const MAX_HOPS = 40;
  for (let hops = 0; hops < MAX_HOPS; hops++) {
    const normalized = normalize(current);
    const root = parse(normalized).root;
    const segments = normalized.slice(root.length).split(sep).filter(Boolean);
    let prefix = root.endsWith(sep) ? root.slice(0, -sep.length) : root;
    let followedSymlink = false;
    for (const segment of segments) {
      prefix += `${sep}${segment}`;
      let st;
      try {
        st = lstatSync(prefix);
      } catch (err) {
        if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
          return normalized;
        }
        return null;
      }
      if (st.isSymbolicLink()) {
        let target;
        try {
          target = readlinkSync(prefix);
        } catch {
          return null;
        }
        const resolvedTarget = isAbsolute(target) ? target : normalize(join(dirname(prefix), target));
        const rest = normalized.slice(prefix.length);
        current = `${resolvedTarget}${rest}`;
        followedSymlink = true;
        break;
      }
    }
    if (!followedSymlink) {
      return normalized;
    }
  }
  return null;
}

export function isRealMount(entryDev: number | null | undefined, rootDev: number | null | undefined): boolean {
  return entryDev != null && rootDev != null && entryDev !== rootDev;
}

function listWindowsVolumeRoots(statFn: typeof statSync): string[] {
  const roots: string[] = [];
  for (const letter of DRIVE_LETTERS) {
    const root = `${letter}:${sep}`;
    try {
      statFn(root);
    } catch {
      continue;
    }
    roots.push(root);
  }
  return roots;
}

export function listMountedVolumes({ statFn = statSync }: { statFn?: typeof statSync } = {}): string[] {
  if (WINDOWS) return listWindowsVolumeRoots(statFn);
  const roots = ['/'];
  let rootDev: number;
  try {
    rootDev = statFn('/').dev;
  } catch {
    return roots;
  }
  try {
    for (const name of readdirSync('/Volumes')) {
      const path = join('/Volumes', name);
      let entryDev;
      try {
        entryDev = statFn(path).dev;
      } catch {
        continue;
      }
      if (isRealMount(entryDev, rootDev)) {
        roots.push(path);
      }
    }
  } catch {}
  return roots;
}

function resolveVolumeRoot(path: string): string | null {
  const realish = resolveWorkspaceRealish(path);
  return realish === null ? null : volumeRootFor(realish);
}

function uncShareIsReachable(volume: string, statFn: typeof statSync): boolean {
  if (!WINDOWS || !volume.startsWith(`${sep}${sep}`)) return false;
  try {
    return statFn(volume).isDirectory();
  } catch {
    return false;
  }
}

export function isOnMountedVolume(
  path: string,
  mountedVolumes?: string[],
  { statFn = statSync }: { statFn?: typeof statSync } = {},
): boolean {
  const mounted = new Set(mountedVolumes || listMountedVolumes());
  const volume = resolveVolumeRoot(path);
  if (volume === null) return false;
  return mounted.has(volume) || uncShareIsReachable(volume, statFn);
}

export function directorySize(dir: string, { timeoutMs }: { timeoutMs?: number } = {}): number {
  return measuredDirectorySize(dir, { timeoutMs }) ?? 0;
}

export function measuredDirectorySize(dir: string, { timeoutMs }: { timeoutMs?: number } = {}): number | null {
  let out: string;
  try {
    out = getExecutor().runFile('du', ['-sk', dir], { timeoutMs });
  } catch {
    return null;
  }
  if (!out) return 0;
  const kb = parseInt(out.split(/\s+/)[0] ?? '', 10);
  return isNaN(kb) ? 0 : kb * 1024;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)}G`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)}M`;
  return `${Math.round(bytes / 1024)}K`;
}
