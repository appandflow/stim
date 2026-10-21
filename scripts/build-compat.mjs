import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const recordFile = 'scripts/build-compat.json';
const constantFile = 'packages/stim-cli/src/offload/toolchain.ts';

/**
 * The files a record covers: each listed file, and every TypeScript source git tracks in a listed directory (an entry
 * ending in `/`), so a new file there is covered without a record change.
 */
export function buildCompatFiles(entries, tracked) {
  const files = entries.flatMap((entry) =>
    entry.endsWith('/')
      ? tracked.filter(
          (file) =>
            file.startsWith(entry) && file.endsWith('.ts') && !file.includes('/__tests__/') && !file.includes('.test.'),
        )
      : [entry],
  );
  return [...new Set(files)].toSorted();
}

/** The digest a record keeps for `files`, from each file's git blob id so line endings do not matter. */
export function buildCompatDigest(files, oids) {
  const hash = createHash('sha256');
  for (const file of [...files].toSorted()) hash.update(`${file}\0${oids[file]}\n`);
  return hash.digest('hex');
}

/** Why the recorded build compatibility no longer describes the listed files; empty when it does. */
export function buildCompatProblems(record, compat, files, oids) {
  const problems = [];
  const missing = files.filter((file) => oids[file] === undefined);
  if (missing.length) problems.push(`Listed files are missing: ${missing.join(', ')}.`);
  if (record.compat !== compat)
    problems.push(`${recordFile} records build compatibility ${record.compat}, but ${constantFile} has ${compat}.`);
  if (!missing.length && record.digest !== buildCompatDigest(files, oids))
    problems.push('A file that decides what a build worker builds, or how, changed since the last record.');
  return problems;
}

function trackedFiles() {
  const result = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ls-files failed: ${result.stderr}`);
  return result.stdout.split('\0').filter(Boolean);
}

function blobIds(files) {
  const present = files.filter((file) => existsSync(join(root, file)));
  if (!present.length) return {};
  const result = spawnSync('git', ['hash-object', '--', ...present], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git hash-object failed: ${result.stderr}`);
  const ids = result.stdout.trim().split('\n');
  return Object.fromEntries(present.map((file, index) => [file, ids[index]]));
}

function main() {
  const record = JSON.parse(readFileSync(join(root, recordFile), 'utf8'));
  const compat = Number(
    /^const STIM_BUILD_COMPAT = (\d+);$/m.exec(readFileSync(join(root, constantFile), 'utf8'))?.[1],
  );
  if (!Number.isSafeInteger(compat)) throw new Error(`No STIM_BUILD_COMPAT in ${constantFile}.`);
  const files = buildCompatFiles(record.files, trackedFiles());
  const oids = blobIds(files);
  if (process.argv.includes('--update')) {
    const entries = [...record.files].toSorted();
    writeFileSync(
      join(root, recordFile),
      `${JSON.stringify({ compat, files: entries, digest: buildCompatDigest(files, oids) }, null, 2)}\n`,
    );
    return;
  }
  const problems = buildCompatProblems(record, compat, files, oids);
  if (!problems.length) return;
  console.error(
    [
      ...problems,
      '',
      `Bump STIM_BUILD_COMPAT in ${constantFile} when a machine with the same value but the other version of these`,
      'files would build a different artifact or read a build or artifact message differently. A fix that makes a',
      'failing worker build succeed, or a field negotiated by a hello feature, needs no bump.',
      `Then run \`node scripts/build-compat.mjs --update\` and commit ${recordFile}.`,
    ].join('\n'),
  );
  process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
