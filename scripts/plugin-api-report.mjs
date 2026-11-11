import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const stimCli = join(root, 'packages', 'stim-cli');
const baselineFile = 'packages/stim-cli/plugin.api.txt';
const notesFile = 'docs/releases/unreleased.md';
const header =
  '// The stim/plugin API report. Regenerate it with `node scripts/plugin-api-report.mjs --update`; see that script.';

/** The plugin kind whose contract a source module of `stim/plugin` defines; others belong to no one kind. */
const MODULE_KINDS = {
  cache: 'cache-provider',
  transport: 'transport',
  'transport-kit': 'transport',
  'agent-driver': 'agent-driver',
  'agent-driver-kit': 'agent-driver',
};

const VERSION_KINDS = { CACHE_PROVIDER: 'cache-provider', TRANSPORT: 'transport', AGENT_DRIVER: 'agent-driver' };

const DECLARED =
  /^(?:export )?(?:declare )?(?:abstract )?(?:const|let|function|class|interface|type|enum|namespace) (\w+)/;

/**
 * One line per declaration member, prefixed by the plugin kind of the module that declares it (`[*]` for none) and its
 * top-level declaration. Comments, region markers, closing brackets and constant values are removed, bundler suffixes
 * such as `Foo$1` are dropped, and the export list is split one name per line, so an addition reads as added lines only.
 */
export function normalizeDeclarations(text) {
  const entries = [];
  const declaredIn = new Map();
  let module = '*';
  let top = '';
  const source = text
    .replace(/\r\n?/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\b(\w+)\$\d+\b/g, '$1');
  for (const raw of source.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    const trimmed = line.trim();
    const region = /^\/\/#region (?:\.\.\/([\w-]+)\/dist\/|src\/([\w-]+)\.d\.ts)/.exec(trimmed);
    if (region) module = MODULE_KINDS[region[1] ?? region[2]] ?? '*';
    if (trimmed === '' || trimmed.startsWith('//') || /^[\])}>;,]+$/.test(trimmed)) continue;
    const exported = /^export \{(.*)\};?$/.exec(trimmed);
    if (exported) {
      for (const name of exported[1]
        .split(',')
        .map((each) => each.trim())
        .filter(Boolean))
        entries.push({
          module: null,
          name: name
            .replace(/^type /, '')
            .split(' as ')
            .pop(),
          text: `export ${name}`,
        });
      continue;
    }
    if (line === trimmed) {
      top = trimmed.replace(/^(declare const \w+) = .*;$/, '$1;');
      const declared = DECLARED.exec(top);
      if (declared) declaredIn.set(declared[1], module);
      entries.push({ module, text: top });
    } else {
      entries.push({ module, text: `${top} | ${trimmed}` });
    }
  }
  const lines = entries.map((entry) => `[${entry.module ?? declaredIn.get(entry.name) ?? '*'}] ${entry.text}`);
  return [...new Set(lines)].toSorted();
}

/** Lines of `from` that `to` lacks. */
function missing(from, to) {
  const have = new Set(to);
  return from.filter((line) => !have.has(line));
}

/** Each kind integer the report declares. */
function kindIntegers(report) {
  const integers = {};
  for (const line of report) {
    const found = /declare const (\w+)_API_VERSION: (\d+);$/.exec(line);
    if (found && VERSION_KINDS[found[1]]) integers[VERSION_KINDS[found[1]]] = Number(found[2]);
  }
  return integers;
}

/** The `## Removed (breaking)` section of the unreleased notes, or an empty string. */
function breakingSection(notes) {
  return /^## Removed \(breaking\)\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(notes.replace(/\r\n?/g, '\n'))?.[1] ?? '';
}

/**
 * What a new report means against the baseline: `same`; `additive` when it only adds lines; `accepted` when it
 * removes or changes lines and, for each kind that owns one of them, that kind's integer went up and the unreleased
 * notes' `## Removed (breaking)` section names the new integer as `<kind> <integer>`; else `breaking`. A line of a
 * module that belongs to no one kind (`[*]`) needs at least one kind bumped. `needs` lists what is missing.
 */
export function apiReportVerdict({ baseline, current, notes }) {
  const removed = missing(baseline, current);
  const added = missing(current, baseline);
  if (removed.length === 0) return { status: added.length === 0 ? 'same' : 'additive', added, removed, needs: [] };
  const before = kindIntegers(baseline);
  const after = kindIntegers(current);
  const bumped = Object.keys(after).filter((kind) => before[kind] !== undefined && after[kind] > before[kind]);
  const owners = new Set(
    removed.filter((line) => !/_API_VERSION: \d+;$/.test(line)).map((line) => /^\[([\w*-]+)\]/.exec(line)?.[1] ?? '*'),
  );
  const section = breakingSection(notes);
  const needs = [];
  for (const owner of owners) {
    if (owner === '*') {
      if (bumped.length === 0) needs.push('a bump of the integer of the kind this change breaks');
    } else if (!bumped.includes(owner)) {
      needs.push(`a bump of the ${owner} integer (now ${before[owner]})`);
    }
  }
  for (const kind of bumped)
    if (!section.includes(`${kind} ${after[kind]}`))
      needs.push(`a line naming "${kind} ${after[kind]}" under "## Removed (breaking)" in ${notesFile}`);
  return { status: needs.length === 0 ? 'accepted' : 'breaking', added, removed, needs };
}

/** Builds the declarations of `stim/plugin` alone, so they hold every type it reaches, and normalizes them. */
export async function generateReport() {
  const { build } = await import('tsdown');
  const out = mkdtempSync(join(tmpdir(), 'stim-plugin-api-'));
  try {
    await build({
      config: false,
      cwd: stimCli,
      entry: { plugin: join(stimCli, 'src', 'plugin.ts') },
      format: 'esm',
      dts: { emitDtsOnly: true },
      outDir: out,
      platform: 'node',
      tsconfig: join(stimCli, 'tsconfig.json'),
      noExternal: [/^@stim-cli\//],
      fixedExtension: true,
      logLevel: 'silent',
    });
    return normalizeDeclarations(readFileSync(join(out, 'plugin.d.mts'), 'utf8'));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

export function readBaseline() {
  const path = join(root, baselineFile);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line !== '' && line !== header);
}

const RUN_UPDATE = 'node scripts/plugin-api-report.mjs --update';

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const update = process.argv.includes('--update');
  const current = await generateReport();
  const verdict = apiReportVerdict({
    baseline: readBaseline(),
    current,
    notes: existsSync(join(root, notesFile)) ? readFileSync(join(root, notesFile), 'utf8') : '',
  });
  const listing = [...verdict.removed.map((line) => `  - ${line}`), ...verdict.added.map((line) => `  + ${line}`)].join(
    '\n',
  );
  if (verdict.status === 'same') {
    console.log(`stim/plugin API report: ${current.length} lines, unchanged.`);
  } else if (verdict.status === 'breaking') {
    console.error(
      `stim/plugin removes or changes lines of ${baselineFile}:\n${listing}\n` +
        'A plugin built against the old lines may break, so this change needs:\n' +
        verdict.needs.map((need) => `  * ${need}`).join('\n') +
        `\nBump the *_API_VERSION constant of each kind named in brackets ([*] lines need the kind they break), add the line to ${notesFile}, then run ${RUN_UPDATE} and commit ${baselineFile}. If the change was not meant to remove anything, restore the removed lines instead.`,
    );
    process.exit(1);
  } else if (update) {
    writeFileSync(join(root, baselineFile), `${[header, ...current].join('\n')}\n`);
    console.log(`Updated ${baselineFile} (${verdict.status}):\n${listing}`);
  } else {
    console.error(
      `stim/plugin differs from ${baselineFile} (${verdict.status === 'additive' ? 'additions only, no bump needed' : 'a bumped breaking change'}):\n${listing}\nRun ${RUN_UPDATE} and commit ${baselineFile}.`,
    );
    process.exit(1);
  }
}
