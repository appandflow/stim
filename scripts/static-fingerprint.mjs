import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blobIds, buildCompatDigest } from './build-compat.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const recordFile = 'scripts/static-fingerprint.json';
const constantFile = 'packages/stim-cli/src/cache/static-fingerprint.ts';

/** Why the recorded static fingerprint schema no longer describes the listed files; empty when it does. */
export function staticFingerprintProblems(record, schema, oids) {
  const problems = [];
  const missing = record.files.filter((file) => oids[file] === undefined);
  if (missing.length) problems.push(`Listed files are missing: ${missing.join(', ')}.`);
  if (record.schema !== schema)
    problems.push(`${recordFile} records static schema ${record.schema}, but ${constantFile} has ${schema}.`);
  if (!missing.length && record.digest !== buildCompatDigest(record.files, oids))
    problems.push(
      'A file that decides the static fingerprint, or the fingerprint a memo records, changed since the last record.',
    );
  return problems;
}

function main() {
  const record = JSON.parse(readFileSync(join(root, recordFile), 'utf8'));
  const schema = Number(/^const STATIC_SCHEMA = (\d+);$/m.exec(readFileSync(join(root, constantFile), 'utf8'))?.[1]);
  if (!Number.isSafeInteger(schema)) throw new Error(`No STATIC_SCHEMA in ${constantFile}.`);
  const files = [...record.files].toSorted();
  const oids = blobIds(files);
  if (process.argv.includes('--update')) {
    writeFileSync(
      join(root, recordFile),
      `${JSON.stringify({ schema, files, digest: buildCompatDigest(files, oids) }, null, 2)}\n`,
    );
    return;
  }
  const problems = staticFingerprintProblems(record, schema, oids);
  if (!problems.length) return;
  console.error(
    [
      ...problems,
      '',
      `Bump STATIC_SCHEMA in ${constantFile} when the other version of these files could give an unchanged tree the`,
      'same static digest but a different full fingerprint, or a different tree the same static digest: a memo record',
      'written by one version would then serve the wrong cache key to the other. Then run',
      `\`node scripts/static-fingerprint.mjs --update\` and commit ${recordFile}.`,
    ].join('\n'),
  );
  process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
