import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const stimCli = join(root, 'packages', 'stim-cli');
const notesFile = 'docs/releases/unreleased.md';

/**
 * Each public entry the gate freezes: `stim/plugin`, and the package root `stim` (`createStim`). `untagged` is the kind
 * that owns the root's lines, which come from no plugin kind's module: a change to them needs the `stim` integer.
 */
const REPORTS = [
  {
    name: 'stim/plugin',
    entry: 'plugin',
    source: 'src/plugin.ts',
    baselineFile: 'packages/stim-cli/plugin.api.txt',
    note: 'The agent-driver and transport kinds are experimental in 2.x: their integers may go up in a minor release. Only cache-provider is frozen.',
  },
  {
    name: 'stim',
    entry: 'api',
    source: 'src/api.ts',
    baselineFile: 'packages/stim-cli/api.api.txt',
    untagged: 'stim',
  },
];

const header = (report) => [
  `// The ${report.name} API report. Regenerate it with \`node scripts/plugin-api-report.mjs --update\`; see that script.`,
  ...(report.note ? [`// ${report.note}`] : []),
];

/** The plugin kind whose contract a source module of `stim/plugin` defines; others belong to no one kind. */
const MODULE_KINDS = {
  cache: 'cache-provider',
  transport: 'transport',
  'transport-kit': 'transport',
  'agent-driver': 'agent-driver',
  'agent-driver-kit': 'agent-driver',
};

const VERSION_KINDS = {
  CACHE_PROVIDER: 'cache-provider',
  TRANSPORT: 'transport',
  AGENT_DRIVER: 'agent-driver',
  STIM: 'stim',
};

/** Interfaces a plugin implements: a new required member breaks every plugin built before it. */
const IMPLEMENTED = new Set([
  'CacheProvider',
  'CacheProviderModule',
  'BuildCacheCapability',
  'FileCacheCapability',
  'Transport',
  'TransportModule',
  'HostedAgentDriver',
  'AgentDriverModule',
]);

const TAG_MARK = '\u0000tag:';

const DECLARED =
  /^(?:export )?(?:declare )?(?:abstract )?(?:const|let|function|class|interface|type|enum|namespace) (\w+)/;

/**
 * One line per declaration member, prefixed by the plugin kind of the module that declares it (`[*]` for none) and its
 * top-level declaration, with one `|` per nesting level. Comments, region markers, closing brackets and constant values
 * are removed, except that a doc comment tagged `@internal` or `@experimental` keeps its tag before the declaration it
 * documents. Bundler suffixes such as `Foo$1` are dropped, and the export list is split one name per line, so an
 * addition reads as added lines only.
 */
export function normalizeDeclarations(text) {
  const entries = [];
  const declaredIn = new Map();
  let module = '*';
  let top = '';
  let tag = '';
  const source = text
    .replace(/\r\n?/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => {
      const found = /@(internal|experimental)\b/.exec(comment);
      return found ? `\n${TAG_MARK}${found[1]}\n` : '';
    })
    .replace(/\b(\w+)\$\d+\b/g, '$1');
  for (const raw of source.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    const trimmed = line.trim();
    if (trimmed.startsWith(TAG_MARK)) {
      tag = `@${trimmed.slice(TAG_MARK.length)} `;
      continue;
    }
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
      const declaration = trimmed.replace(/^(declare const \w+) = .*;$/, '$1;');
      const declared = DECLARED.exec(declaration);
      if (declared) declaredIn.set(declared[1], module);
      top = `${tag}${declaration}`;
      entries.push({ module, text: top });
    } else {
      const depth = Math.max(
        1,
        Math.floor(line.slice(0, line.length - trimmed.length).replace(/\t/g, '  ').length / 2),
      );
      entries.push({ module, text: `${top} ${'|'.repeat(depth)} ${tag}${trimmed}` });
    }
    tag = '';
  }
  const lines = entries.map((entry) => `[${entry.module ?? declaredIn.get(entry.name) ?? '*'}] ${entry.text}`);
  return [...new Set(lines)].toSorted();
}

/** A line of a declaration, or a member, whose doc comment says it is `@internal`: not part of the API. */
const INTERNAL = /^\[[\w*-]+\] @internal |^[^|]* \|+ @internal /;

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

/** Added lines that give an interface a plugin implements, and the baseline already has, a new required member. */
function requiredMembers(added, baseline) {
  const existing = new Set(baseline);
  return added.filter((line) => {
    const member =
      /^(\[[\w*-]+\] (?:@\w+ )?interface (\w+)\b[^|]*?) \| (?:@\w+ )?(?:readonly )?(\w+|\[[^\]]+\])(\??)[(:<]/.exec(
        line,
      );
    return member !== null && IMPLEMENTED.has(member[2]) && member[4] === '' && existing.has(member[1]);
  });
}

/**
 * What a new report means against the baseline: `same`; `additive` when it only adds lines; `accepted` when it
 * removes or changes lines, or adds a required member to an interface a plugin implements, and, for each kind that
 * owns one of them, that kind's integer went up and the unreleased notes' `## Removed (breaking)` section names the
 * new integer as `<kind> <integer>`; else `breaking`. Removing or changing a line tagged `@internal` is additive. A
 * line tagged `[*]` belongs to `untagged` when the report names
 * one; otherwise it belongs to no one kind and needs at least one kind bumped. `needs` lists what is missing.
 */
export function apiReportVerdict({ baseline, current, notes, untagged }) {
  const removed = missing(baseline, current);
  const added = missing(current, baseline);
  const required = requiredMembers(added, baseline);
  const breaks = [...removed.filter((line) => !/_API_VERSION: \d+;$/.test(line) && !INTERNAL.test(line)), ...required];
  if (breaks.length === 0 && !removed.some((line) => /_API_VERSION: \d+;$/.test(line)))
    return {
      status: added.length === 0 ? 'same' : 'additive',
      added,
      removed,
      required,
      needs: [],
    };
  const before = kindIntegers(baseline);
  const after = kindIntegers(current);
  const bumped = Object.keys(after).filter((kind) => before[kind] !== undefined && after[kind] > before[kind]);
  const owners = new Set(
    breaks.map((line) => {
      const owner = /^\[([\w*-]+)\]/.exec(line)?.[1] ?? '*';
      return owner === '*' && untagged ? untagged : owner;
    }),
  );
  const section = breakingSection(notes);
  const needs = [];
  for (const owner of owners) {
    if (owner === '*') {
      if (bumped.length === 0) needs.push('a bump of the integer of the kind this change breaks');
    } else if (!bumped.includes(owner)) {
      needs.push(`a bump of the ${owner} integer (now ${before[owner] ?? 'undeclared'})`);
    }
  }
  for (const kind of bumped)
    if (!new RegExp(`(?<![\\w-])${kind} ${after[kind]}(?![\\w.])`).test(section))
      needs.push(`a line naming "${kind} ${after[kind]}" under "## Removed (breaking)" in ${notesFile}`);
  return { status: needs.length === 0 ? 'accepted' : 'breaking', added, removed, required, needs };
}

/** Builds the declarations of one entry alone, so they hold every type it reaches, and normalizes them. */
export async function generateReport(report = REPORTS[0]) {
  const { build } = await import('tsdown');
  const out = mkdtempSync(join(tmpdir(), 'stim-plugin-api-'));
  try {
    await build({
      config: false,
      cwd: stimCli,
      entry: { [report.entry]: join(stimCli, report.source) },
      format: 'esm',
      dts: { emitDtsOnly: true },
      outDir: out,
      platform: 'node',
      tsconfig: join(stimCli, 'tsconfig.json'),
      noExternal: [/^@stim-cli\//],
      fixedExtension: true,
      logLevel: 'silent',
    });
    return normalizeDeclarations(readFileSync(join(out, `${report.entry}.d.mts`), 'utf8'));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

export function readBaseline(report = REPORTS[0]) {
  const path = join(root, report.baselineFile);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line !== '' && !line.startsWith('//'));
}

const RUN_UPDATE = 'node scripts/plugin-api-report.mjs --update';

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const update = process.argv.includes('--update');
  const notes = existsSync(join(root, notesFile)) ? readFileSync(join(root, notesFile), 'utf8') : '';
  for (const report of REPORTS) {
    const { name, baselineFile } = report;
    const current = await generateReport(report);
    const verdict = apiReportVerdict({ baseline: readBaseline(report), current, notes, untagged: report.untagged });
    const listing = [
      ...verdict.removed.map((line) => `  - ${line}`),
      ...verdict.added.map((line) => `  + ${line}`),
    ].join('\n');
    if (verdict.status === 'same') {
      console.log(`${name} API report: ${current.length} lines, unchanged.`);
    } else if (verdict.status === 'breaking') {
      console.error(
        `${name} removes or changes lines of ${baselineFile}, or adds a required member to an interface a plugin implements:\n${listing}\n` +
          'A caller built against the old lines may break, so this change needs:\n' +
          verdict.needs.map((need) => `  * ${need}`).join('\n') +
          `\nBump the *_API_VERSION constant of each kind named in brackets ([*] lines need the kind they break), add the line to ${notesFile}, then run ${RUN_UPDATE} and commit ${baselineFile}. If the change was not meant to remove anything, restore the removed lines instead. In the stim/plugin report, lines tagged [*] come from a module that defines no single kind, an export under another name, or a file in a src/ subdirectory; they need at least one kind bumped. In the stim report they need the stim integer (STIM_API_VERSION).`,
      );
      process.exitCode = 1;
    } else if (update) {
      writeFileSync(join(root, baselineFile), `${[...header(report), ...current].join('\n')}\n`);
      console.log(`Updated ${baselineFile} (${verdict.status}):\n${listing}`);
    } else {
      console.error(
        `${name} differs from ${baselineFile} (${verdict.status === 'additive' ? 'additions only, no bump needed' : 'a bumped breaking change'}):\n${listing}\nRun ${RUN_UPDATE} and commit ${baselineFile}.`,
      );
      process.exitCode = 1;
    }
  }
}
