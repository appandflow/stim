import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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
const missing = packages.filter((name) => !existsSync(join(root, name)));
if (missing.length > 0) throw new Error(`No such package directory: ${missing.join(', ')}`);
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
if (!lint.stdout.trimStart().startsWith('{'))
  throw new Error(`oxlint matched no files under ${packages.join(', ')}: ${lint.stdout.trim()}`);
const { diagnostics } = JSON.parse(lint.stdout);

const baseline = JSON.parse(readFileSync(baselineFile, 'utf8'));
const counts = {};
for (const name of packages) counts[name] = { src: { as: 0, nonNull: 0 }, test: { as: 0, nonNull: 0 } };
for (const { code, filename: reported } of diagnostics) {
  const filename = reported.replaceAll('\\', '/');
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

const update = `Run ${['node scripts/type-assertion-ratchet.mjs', ...named, '--update'].join(' ')} from the repository root to write the current counts to scripts/type-assertion-baseline.json.`;
const above = [];
const below = [];
for (const name of packages) {
  for (const bucket of ['src', 'test']) {
    for (const kind of ['as', 'nonNull']) {
      const now = counts[name][bucket][kind];
      const allowed = baseline[name]?.[bucket]?.[kind] ?? 0;
      if (now > allowed) above.push(`${name} ${bucket}: ${now} ${kind} assertions, baseline ${allowed}.`);
      else if (now < allowed) below.push(`${name} ${bucket}: ${now} ${kind} assertions, baseline ${allowed}.`);
    }
  }
}
if (below.length > 0) console.error(`${below.join('\n')}\nThe baseline can be lowered. ${update}`);
if (above.length > 0) {
  console.error(
    `${above.join('\n')}\nNarrow the type instead of asserting it. A needed assertion raises the baseline: ${update}`,
  );
  process.exit(1);
}
