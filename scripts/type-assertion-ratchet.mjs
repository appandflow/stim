import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const baselineFile = join(root, 'scripts/type-assertion-baseline.json');
const defaultPackages = [
  '.github/actions/stim-ci',
  'packages/cache',
  'packages/ci',
  'packages/core',
  'packages/expo-build-cache',
  'packages/metro',
  'packages/server',
  'packages/stim-cli',
];
const named = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const packages = named.length > 0 ? named : defaultPackages;
const kinds = { 'typescript(consistent-type-assertions)': 'as', 'typescript(no-non-null-assertion)': 'nonNull' };

const lint = spawnSync(
  process.execPath,
  [
    join(root, 'node_modules/oxlint/bin/oxlint'),
    '-c',
    join(root, 'scripts/type-assertions.oxlintrc.json'),
    '--disable-nested-config',
    '-f',
    'json',
    ...packages,
  ],
  { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
);
if (lint.error) throw lint.error;
const { diagnostics } = JSON.parse(lint.stdout);

const baseline = JSON.parse(readFileSync(baselineFile, 'utf8'));
const counts = {};
for (const name of packages) counts[name] = { src: { as: 0, nonNull: 0 }, test: { as: 0, nonNull: 0 } };
for (const { code, filename } of diagnostics) {
  const kind = kinds[code];
  const name = packages.find((candidate) => filename.startsWith(`${candidate}/`));
  if (!kind || !name) throw new Error(`Unexpected oxlint result: ${code} in ${filename}`);
  const bucket = /(^|\/)(__tests__|test)\/|\.test\.tsx?$/.test(filename.slice(name.length)) ? 'test' : 'src';
  counts[name][bucket][kind]++;
}

if (process.argv.includes('--update')) {
  const updated = Object.fromEntries(
    Object.entries({ ...baseline, ...counts }).toSorted(([a], [b]) => a.localeCompare(b)),
  );
  writeFileSync(baselineFile, `${JSON.stringify(updated, null, 2)}\n`);
  process.exit(0);
}

const problems = [];
for (const name of packages) {
  for (const bucket of ['src', 'test']) {
    for (const kind of ['as', 'nonNull']) {
      const now = counts[name][bucket][kind];
      const allowed = baseline[name]?.[bucket]?.[kind] ?? 0;
      if (now > allowed)
        problems.push(`${name} ${bucket}: ${now} ${kind} assertions, baseline ${allowed}. Narrow the type instead.`);
      else if (now < allowed)
        problems.push(`${name} ${bucket}: ${now} ${kind} assertions, baseline ${allowed}. Lower the baseline.`);
    }
  }
}
if (problems.length > 0) {
  console.error(problems.join('\n'));
  console.error(
    `Run ${['node scripts/type-assertion-ratchet.mjs', ...named, '--update'].join(' ')} from the repository root to write the current counts to scripts/type-assertion-baseline.json.`,
  );
  process.exit(1);
}
