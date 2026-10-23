import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isJsonObject } from '@stim-cli/core/state';

const REPORT_WINDOW_MS = 10 * 60 * 1000;
const MAX_CANDIDATES = 20;
const MAX_STORED = 40;
const MAX_REPORT_BYTES = 1024 * 1024;
const MAX_COPIED_BYTES = 8 * 1024 * 1024;

export interface SpringBoardReportText {
  name: string;
  text: string;
}

export function selectSpringBoardReports(entries: SpringBoardReportText[], udid: string, sinceMs: number): string[] {
  const owner = `.${udid}`.toLowerCase();
  return entries.flatMap(({ name, text }) => {
    if (!/^SpringBoard-.+\.ips$/.test(name)) return [];
    try {
      const report: unknown = JSON.parse(text.slice(text.indexOf('\n') + 1));
      if (!isJsonObject(report)) return [];
      const { coalitionName, captureTime } = report;
      const capturedAt = Date.parse(typeof captureTime === 'string' ? captureTime : '');
      return typeof coalitionName === 'string' && coalitionName.toLowerCase().endsWith(owner) && capturedAt >= sinceMs
        ? [name]
        : [];
    } catch {
      return [];
    }
  });
}

/**
 * Copies this simulator's recent SpringBoard crash reports from DiagnosticReports and its Retired folder into
 * `destDir`, which keeps at most 40 of them. The source folders are only read; macOS deletes their reports after
 * about two days. Returns the matching reports now in `destDir` and how many matched but did not fit its limits.
 */
export async function copySpringBoardCrashReports({
  udid,
  destDir,
  now = Date.now(),
  home = homedir(),
}: {
  udid: string;
  destDir: string;
  now?: number;
  home?: string;
}): Promise<{ files: string[]; dropped: number }> {
  const since = now - REPORT_WINDOW_MS;
  const reportsDir = join(home, 'Library/Logs/DiagnosticReports');
  const candidates = new Map<string, { path: string; mtimeMs: number }>();
  for (const directory of [reportsDir, join(reportsDir, 'Retired')]) {
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue;
      throw error;
    }
    for (const name of names) {
      if (!/^SpringBoard-.+\.ips$/.test(name) || candidates.has(name)) continue;
      try {
        const path = join(directory, name);
        const { mtimeMs, size } = await stat(path);
        if (mtimeMs >= since && size <= MAX_REPORT_BYTES) candidates.set(name, { path, mtimeMs });
      } catch {}
    }
  }
  const newest = [...candidates].toSorted((a, b) => b[1].mtimeMs - a[1].mtimeMs).slice(0, MAX_CANDIDATES);
  const entries: SpringBoardReportText[] = [];
  for (const [name, { path }] of newest) {
    try {
      entries.push({ name, text: await readFile(path, 'utf8') });
    } catch {}
  }
  const matching = selectSpringBoardReports(entries, udid, since);
  if (matching.length === 0) return { files: [], dropped: 0 };

  await mkdir(destDir, { recursive: true, mode: 0o700 });
  let stored = (await readdir(destDir)).filter((name) => /^SpringBoard-.+\.ips$/.test(name)).length;
  let copiedBytes = 0;
  const files: string[] = [];
  for (const { name, text } of entries) {
    if (!matching.includes(name)) continue;
    const bytes = Buffer.byteLength(text);
    if (stored >= MAX_STORED || copiedBytes + bytes > MAX_COPIED_BYTES) break;
    try {
      await writeFile(join(destDir, name), text, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
        files.push(name);
        continue;
      }
      await rm(join(destDir, name), { force: true });
      throw error;
    }
    stored++;
    copiedBytes += bytes;
    files.push(name);
  }
  return { files, dropped: matching.length - files.length };
}
