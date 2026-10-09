import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';

async function regularFiles(directory: string, resolveDirectory = false): Promise<string[]> {
  try {
    if (resolveDirectory) directory = await realpath(directory);
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

/** Lists CI result, test and diagnostic evidence from an explicit root, excluding linked entries and app binaries. */
export async function diagnosticArtifactFiles(artifactsDir: string): Promise<string[]> {
  const reports = new Set(['result.json', 'run.json', 'diagnostics.json', 'test.stdout.log', 'test.stderr.log']);
  const files = (await regularFiles(artifactsDir, true))
    .filter((name) => reports.has(name))
    .map((name) => join(artifactsDir, name));
  const logs = join(artifactsDir, 'logs');
  return [...files, ...(await regularFiles(logs)).filter(isLog).map((name) => join(logs, name))];
}

/** Lists build reports and a completed APK or app archive, excluding linked entries and partial exports. */
export async function buildArtifactFiles(artifactsDir: string, artifactPath: string | null): Promise<string[]> {
  const root = await realpath(artifactsDir);
  const names = await regularFiles(root);
  const files = await diagnosticArtifactFiles(root);
  for (const name of ['build.json', 'artifact.stdout.log', 'artifact.stderr.log'])
    if (names.includes(name)) files.push(join(root, name));
  if (artifactPath !== null) {
    const selected = ['app.apk', 'app.tar.gz'].find((name) =>
      [join(root, name), join(resolve(artifactsDir), name)].includes(resolve(artifactPath)),
    );
    if (!selected || !names.includes(selected))
      throw new Error('Build artifact must be a regular exported APK or app archive inside the results directory.');
    files.push(join(root, selected));
  }
  return files;
}
