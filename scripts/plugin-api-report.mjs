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

/**
 * One line per declaration member, prefixed by its top-level declaration, with comments, region markers and closing
 * brackets removed, and the export list split one name per line, so an addition reads as added lines only.
 */
export function normalizeDeclarations(text) {
  const lines = [];
  let top = '';
  const source = text.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const raw of source.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('//') || /^[\])}>;,]+$/.test(trimmed)) continue;
    const exported = /^export \{(.*)\};?$/.exec(trimmed);
    if (exported) {
      for (const name of exported[1]
        .split(',')
        .map((each) => each.trim())
        .filter(Boolean))
        lines.push(`export ${name}`);
      continue;
    }
    if (line === trimmed) {
      top = trimmed;
      lines.push(trimmed);
    } else {
      lines.push(`${top} | ${trimmed}`);
    }
  }
  return [...new Set(lines)].toSorted();
}

/** Lines of `from` that `to` lacks. */
function missing(from, to) {
  const have = new Set(to);
  return from.filter((line) => !have.has(line));
}

/** Whether the unreleased notes have a `## Removed (breaking)` entry that names `stim/plugin`. */
export function hasBreakingNote(notes) {
  const section = /^## Removed \(breaking\)\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(notes);
  return Boolean(section && section[1].includes('stim/plugin'));
}

/**
 * What a new report means against the baseline: `same`; `additive` when it only adds lines; `breaking` when it
 * removes or changes a line without a kind integer change and a release note; `accepted` when it does with both.
 */
export function apiReportVerdict({ baseline, current, notes }) {
  const removed = missing(baseline, current);
  const added = missing(current, baseline);
  if (removed.length === 0) return { status: added.length === 0 ? 'same' : 'additive', added, removed };
  const integerChanged = removed.some((line) => /_API_VERSION: \d+/.test(line));
  return { status: integerChanged && hasBreakingNote(notes) ? 'accepted' : 'breaking', added, removed };
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

const BREAKING_REMEDY = `A removed or changed line breaks plugins built against stim/plugin. Bump the kind's integer (the *_API_VERSION constant) and add a line naming stim/plugin under "## Removed (breaking)" in ${notesFile}, then run node scripts/plugin-api-report.mjs --update.`;

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
    console.error(`stim/plugin changed in a way that is not additive:\n${listing}\n${BREAKING_REMEDY}`);
    process.exit(1);
  } else if (update) {
    writeFileSync(join(root, baselineFile), `${[header, ...current].join('\n')}\n`);
    console.log(`Updated ${baselineFile} (${verdict.status}):\n${listing}`);
  } else {
    console.error(
      `stim/plugin differs from ${baselineFile} (${verdict.status}):\n${listing}\nRun node scripts/plugin-api-report.mjs --update and commit the report.`,
    );
    process.exit(1);
  }
}
