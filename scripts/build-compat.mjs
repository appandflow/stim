import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const recordFile = 'scripts/build-compat.json';
const constantFile = 'packages/core/state/stim-build.ts';

/** The digest a record keeps for `files`, from each file's git blob id so line endings do not matter. */
export function buildCompatDigest(files, oids) {
  const hash = createHash('sha256');
  for (const file of [...files].toSorted()) hash.update(`${file}\0${oids[file]}\n`);
  return hash.digest('hex');
}

/** Why the recorded build compatibility no longer describes the listed files; empty when it does. */
export function buildCompatProblems(record, compat, oids) {
  const problems = [];
  const missing = record.files.filter((file) => oids[file] === undefined);
  if (missing.length) problems.push(`Listed files are missing: ${missing.join(', ')}.`);
  if (record.compat !== compat)
    problems.push(`${recordFile} records build compatibility ${record.compat}, but ${constantFile} has ${compat}.`);
  if (!missing.length && record.digest !== buildCompatDigest(record.files, oids))
    problems.push('A file that decides what a build worker builds, or how, changed since the last record.');
  return problems;
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
    /export const STIM_BUILD_COMPAT = (\d+);/.exec(readFileSync(join(root, constantFile), 'utf8'))?.[1],
  );
  if (!Number.isSafeInteger(compat)) throw new Error(`No STIM_BUILD_COMPAT in ${constantFile}.`);
  const oids = blobIds(record.files);
  if (process.argv.includes('--update')) {
    const files = [...record.files].toSorted();
    writeFileSync(
      join(root, recordFile),
      `${JSON.stringify({ compat, files, digest: buildCompatDigest(files, oids) }, null, 2)}\n`,
    );
    return;
  }
  const problems = buildCompatProblems(record, compat, oids);
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
