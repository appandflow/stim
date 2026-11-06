import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const baselineFile = join(root, 'scripts/ratchet-baseline.json');
const defaultPackages = [
  '.github/actions/stim-ci',
  'packages/agent-driver',
  'packages/agent-driver-agent-device',
  'packages/cache',
  'packages/cache-s3',
  'packages/ci',
  'packages/core',
  'packages/expo-build-cache',
  'packages/metro',
  'packages/server',
  'packages/stim-cli',
  'packages/transport',
  'packages/transport-tailscale',
  'packages/transport-local',
];
const named = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const packages = named.length > 0 ? named : defaultPackages;
const missing = packages.filter((name) => !existsSync(join(root, name)));
if (missing.length > 0) throw new Error(`No such package directory: ${missing.join(', ')}`);
const kinds = {
  'typescript(consistent-type-assertions)': 'as',
  'typescript(no-non-null-assertion)': 'nonNull',
  'stim(refusal-remedy)': 'refusalRemedy',
};
const counted = { src: ['as', 'nonNull', 'refusalRemedy'], test: ['as', 'nonNull'] };
const advice = {
  as: 'Narrow the type instead of asserting it.',
  nonNull: 'Narrow the type instead of asserting it.',
  refusalRemedy: 'Give each STIM_* refusal a remedy that says how to recover.',
};

const lint = spawnSync(
  process.execPath,
  [
    join(root, 'node_modules/oxlint/bin/oxlint'),
    '-c',
    join(root, 'scripts/ratchet.oxlintrc.json'),
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
for (const name of packages) {
  counts[name] = Object.fromEntries(
    Object.entries(counted).map(([bucket, names]) => [bucket, Object.fromEntries(names.map((kind) => [kind, 0]))]),
  );
}
for (const { code, filename: reported } of diagnostics) {
  const filename = reported.replaceAll('\\', '/');
  const kind = kinds[code];
  const name = packages.find((candidate) => filename.startsWith(`${candidate}/`));
  if (!kind || !name) throw new Error(`Unexpected oxlint result: ${code} in ${filename}`);
  const bucket = /(^|\/)(__tests__|test)\/|\.test\.[cm]?[jt]sx?$/.test(filename.slice(name.length)) ? 'test' : 'src';
  if (counted[bucket].includes(kind)) counts[name][bucket][kind]++;
}

if (process.argv.includes('--update')) {
  const updated = Object.fromEntries(
    Object.entries({ ...baseline, ...counts }).toSorted(([a], [b]) => a.localeCompare(b)),
  );
  writeFileSync(baselineFile, `${JSON.stringify(updated, null, 2)}\n`);
  process.exit(0);
}

const update = `Run ${['node scripts/ratchet.mjs', ...named, '--update'].join(' ')} from the repository root to write the current counts to scripts/ratchet-baseline.json.`;
const above = [];
const below = [];
for (const name of packages) {
  for (const [bucket, names] of Object.entries(counted)) {
    for (const kind of names) {
      const now = counts[name][bucket][kind];
      const allowed = baseline[name]?.[bucket]?.[kind] ?? 0;
      if (now > allowed) above.push({ kind, line: `${name} ${bucket}: ${now} ${kind}, baseline ${allowed}.` });
      else if (now < allowed) below.push(`${name} ${bucket}: ${now} ${kind}, baseline ${allowed}.`);
    }
  }
}
if (below.length > 0) console.error(`${below.join('\n')}\nThe baseline can be lowered. ${update}`);
if (above.length > 0) {
  const hints = [...new Set(above.map(({ kind }) => advice[kind]))].join(' ');
  console.error(
    `${above.map(({ line }) => line).join('\n')}\n${hints} A needed exception raises the baseline: ${update}`,
  );
  process.exit(1);
}
