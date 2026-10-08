import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';

async function regularFiles(directory: string): Promise<string[]> {
  try {
    if (!(await lstat(directory)).isDirectory()) return [];
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .toSorted();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function isLog(name: string): boolean {
  return /\.(?:log|ndjson)(?:\.1)?$/.test(name);
}

/** Copies regular, non-symlink log files directly inside the public diagnostics directory. */
export async function copyDiagnosticLogs(directory: string, artifactsDir: string): Promise<string[]> {
  const names = (await regularFiles(directory)).filter(isLog);
  const destination = join(artifactsDir, 'logs');
  if (names.length) {
    await mkdir(destination, { recursive: true });
    if (!(await lstat(destination)).isDirectory())
      throw new Error('Diagnostic logs destination must be a regular directory.');
  }
  const files: string[] = [];
  for (const name of names) {
    const target = join(destination, name);
    await copyFile(join(directory, name), target, constants.COPYFILE_EXCL);
    files.push(target);
  }
  return files;
}

/** Lists only CI result, test and diagnostic evidence; never follows links or includes app binaries. */
export async function diagnosticArtifactFiles(artifactsDir: string): Promise<string[]> {
  const reports = new Set(['result.json', 'run.json', 'diagnostics.json', 'test.stdout.log', 'test.stderr.log']);
  const files = (await regularFiles(artifactsDir))
    .filter((name) => reports.has(name))
    .map((name) => join(artifactsDir, name));
  const logs = join(artifactsDir, 'logs');
  return [...files, ...(await regularFiles(logs)).filter(isLog).map((name) => join(logs, name))];
}
