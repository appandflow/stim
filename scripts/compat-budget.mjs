import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const budgetFile = 'scripts/compat-budget.json';
const open = /^\s*\/\/ compat (C\d+) (permanent|until \S+)\s*$/;
const close = /^\s*\/\/ compat end\s*$/;
const word = /legacy|compat(?!ib)|deprecat|peer-too-old|STIM_BUILD_COMPAT/gi;

/**
 * Non-blank lines between `// compat C<N> ...` and `// compat end`, per row; the indexes of those lines and their
 * markers; and the marker mistakes in `text`.
 */
export function markedLines(file, text) {
  const counts = {};
  const problems = [];
  const marked = new Set();
  let row = null;
  text.split('\n').forEach((line, index) => {
    const at = `${file}:${index + 1}`;
    const start = open.exec(line);
    if (start) {
      if (row) problems.push(`${at} opens ${start[1]} inside an open ${row} block.`);
      row = start[1];
      counts[row] ??= 0;
      marked.add(index);
    } else if (close.test(line)) {
      if (!row) problems.push(`${at} closes a compat block that is not open.`);
      row = null;
      marked.add(index);
    } else if (/^\s*\/\/ compat /.test(line)) {
      problems.push(`${at} is not "// compat C<N> permanent", "// compat C<N> until <version>" or "// compat end".`);
    } else if (row && line.trim() !== '') {
      counts[row]++;
      marked.add(index);
    }
  });
  if (row) problems.push(`${file} leaves the ${row} block open.`);
  return { counts, problems, marked };
}

/** Rows that are unknown or over their budget. */
export function budgetProblems(counts, rows) {
  return Object.entries(counts).flatMap(([row, lines]) => {
    if (!rows[row]) return [`${row} is not a row of ${budgetFile}.`];
    if (lines > rows[row].loc) return [`${row} marks ${lines} lines, over its budget of ${rows[row].loc}.`];
    return [];
  });
}

const tracked = (patterns) =>
  execFileSync('git', ['ls-files', '-z', ...patterns], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { rows, words } = JSON.parse(readFileSync(join(root, budgetFile), 'utf8'));
  const sources = tracked(['*.ts', '*.tsx', '*.mts', '*.mjs', '*.cjs', '*.js', '*.swift']).filter(
    (file) => !/(^|\/)(__tests__|node_modules|dist)\/|\.test\.[cm]?[jt]sx?$|\.d\.[cm]?ts$/.test(file),
  );
  const totals = {};
  const problems = [];
  const outside = [];
  const scanned = /^(packages\/.+\.m?ts|apps\/mobile\/src\/.+\.tsx?)$/;
  for (const file of sources) {
    const text = readFileSync(join(root, file), 'utf8');
    if (!/compat|legacy|deprecat|peer-too-old/i.test(text)) continue;
    const found = markedLines(file, text);
    problems.push(...found.problems);
    for (const [row, lines] of Object.entries(found.counts)) totals[row] = (totals[row] ?? 0) + lines;
    if (!scanned.test(file)) continue;
    text.split('\n').forEach((line, index) => {
      if (found.marked.has(index)) return;
      for (const match of line.matchAll(word)) {
        const name = match[0].toLowerCase().replace('stim_build_', '');
        const kind = Object.entries(words).find(([, files]) => files.includes(`${file} ${name}`))?.[0];
        outside.push({ at: `${file}:${index + 1}`, name, kind: kind ?? 'unclassified' });
      }
    });
  }
  problems.push(...budgetProblems(totals, rows));
  const sum = Object.values(totals).reduce((a, b) => a + b, 0);
  const byKind = Object.groupBy(outside, ({ kind }) => kind);
  const kinds = Object.entries(byKind).map(([kind, hits]) => `${kind} ${hits.length}`);
  console.log(`Compat budget: ${sum} marked lines. Compat words outside markers: ${kinds.join(', ') || 'none'}.`);
  if (process.argv.includes('--report')) {
    for (const [row, { loc, end }] of Object.entries(rows))
      console.log(`  ${row}: ${totals[row] ?? 0} of ${loc} lines, ${end}`);
    for (const { at, name } of byKind.unclassified ?? []) console.log(`  unclassified ${name}: ${at}`);
  }
  if (problems.length > 0) {
    console.error(problems.join('\n'));
    process.exit(1);
  }
}
