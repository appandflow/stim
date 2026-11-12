import { existsSync } from 'node:fs';
import { isJsonObject } from '@stim-cli/core/state';
import { getExecutor } from '../exec.ts';

/** The pids in `lsof -t` output, or null when a line is not a pid. */
function parseLsofPids(stdout: string): number[] | null {
  const pids: number[] = [];
  for (const line of stdout.split('\n')) {
    const text = line.trim();
    if (!text) continue;
    if (!/^\d+$/.test(text)) return null;
    pids.push(Number(text));
  }
  return pids;
}

/**
 * The processes other than this one that hold any of `files` open, through `lsof`, or null when that cannot be
 * established, including when a file is gone: an unlinked file can still be open. An app's output file can outlive the app in a helper that left its process group, so only this list,
 * empty, proves that every writer closed it.
 *
 * @ref LLP 0017#every-writer-gone -- the app's group and leader are not the set of writers
 */
export async function outputWriters(files: readonly string[]): Promise<number[] | null> {
  if (!files.every((file) => existsSync(file))) return null;
  let stdout: string;
  try {
    stdout = await getExecutor().runFileAsync('lsof', ['-w', '-t', '--', ...files], {
      timeoutMs: 10_000,
      killSignal: 'SIGKILL',
    });
  } catch (error) {
    // lsof exits 1 when any named file is not open, even while it lists holders of the others.
    const { status, stderr, stdout: out } = isJsonObject(error) ? error : {};
    if (status !== 1 || String(stderr ?? '').trim() || typeof out !== 'string') return null;
    stdout = out;
  }
  const pids = parseLsofPids(stdout);
  return pids && [...new Set(pids)].filter((pid) => pid !== process.pid);
}

/** The pids in `ps -axo pid=,pgid=,stat=` output that belong to process group `pgid` and are not zombies. */
export function liveGroupPids(psOutput: string, pgid: number): number[] {
  return psOutput
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter(([pid, group, stat]) => pid && Number(group) === pgid && !stat?.startsWith('Z'))
    .map(([pid]) => Number(pid));
}
