import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultMapping } from './release-qa-matrix.data.mjs';

const allPlatforms = ['ios', 'android'];
const allFrameworks = ['expo', 'bare'];
const usage =
  'usage: node scripts/release-qa-matrix.mjs <last-published-tag> [--until <ref>] [--format checklist|markdown]';

/** The rule whose path is the longest prefix of `path`, or undefined. */
function classifyPath(path, rules = defaultMapping.rules) {
  let best;
  for (const rule of rules) {
    if (path !== rule.path && !path.startsWith(`${rule.path}/`)) continue;
    if (!best || rule.path.length > best.path.length) best = rule;
  }
  return best;
}

/**
 * Turn changed paths into the RELEASE.md section 3 rows the diff can affect.
 * A change carrying `exemptReason` is taken as having no native effect; a path
 * the mapping does not cover requires every row.
 */
export function computeQaMatrix(changes, mapping = defaultMapping) {
  const rows = mapping.rows.map((row) => ({
    ...row,
    required: false,
    platforms: new Set(),
    frameworks: new Set(),
    causes: [],
  }));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const exempt = [];
  const unclassified = [];

  for (const change of changes) {
    if (change.exemptReason) {
      exempt.push({ path: change.path, reason: change.exemptReason });
      continue;
    }
    const rule = classifyPath(change.path, mapping.rules);
    if (!rule) {
      unclassified.push(change.path);
      continue;
    }
    if (rule.exempt) {
      exempt.push({ path: change.path, reason: rule.exempt });
      continue;
    }
    const platforms = rule.platforms ?? allPlatforms;
    const frameworks = rule.frameworks ?? allFrameworks;
    for (const id of rule.rows) {
      const row = byId.get(id);
      if (!row) throw new Error(`rule ${rule.path} names unknown row ${id}`);
      row.required = true;
      row.causes.push({ ...change, rule: rule.path, platforms, frameworks });
      for (const platform of platforms) row.platforms.add(platform);
      for (const framework of frameworks) row.frameworks.add(framework);
    }
  }

  for (const row of rows) {
    if (unclassified.length > 0) {
      row.required = true;
      for (const platform of allPlatforms) row.platforms.add(platform);
      for (const framework of allFrameworks) row.frameworks.add(framework);
    }
    row.platforms = allPlatforms.filter((platform) => row.platforms.has(platform));
    row.frameworks = allFrameworks.filter((framework) => row.frameworks.has(framework));
    row.reason = row.required
      ? unclassified.length > 0 && row.causes.length === 0
        ? `the mapping does not cover ${unclassified.join(', ')}, so the full matrix is required`
        : row.causes.map((cause) => cause.path).join(', ')
      : changes.length === 0
        ? 'the diff is empty'
        : row.absent;
  }

  return { changed: changes.length, rows, exempt, unclassified };
}

function scope(row) {
  if (row.axis === 'global') return '';
  const parts = row.axis === 'framework+platform' ? [row.frameworks, row.platforms] : [row.platforms];
  return parts
    .filter((part) => part.length > 0)
    .map((part) => part.join(', '))
    .join(' x ');
}

function groupExempt(exempt) {
  const groups = new Map();
  for (const entry of exempt) {
    const paths = groups.get(entry.reason) ?? [];
    paths.push(entry.path);
    groups.set(entry.reason, paths);
  }
  return [...groups].map(([reason, paths]) => ({ reason, paths }));
}

function samplePaths(paths, limit = 6) {
  if (paths.length <= limit) return paths.join(', ');
  return `${paths.slice(0, limit).join(', ')}, and ${paths.length - limit} more`;
}

export function renderChecklist(result, context) {
  const required = result.rows.filter((row) => row.required);
  const omitted = result.rows.filter((row) => !row.required);
  const lines = [
    `Release QA matrix for ${context.range}`,
    `${result.changed} changed paths: ${result.changed - result.exempt.length - result.unclassified.length} mapped to a QA row, ${result.exempt.length} with no native effect, ${result.unclassified.length} unclassified`,
    '',
    `Required rows (${required.length} of ${result.rows.length})`,
  ];
  if (required.length === 0) lines.push('  none');
  for (const row of required) {
    const shown = scope(row);
    lines.push(`  [ ] ${row.id}${shown ? `  ${shown}` : ''}`);
    lines.push(`      evidence: ${row.evidence}`);
    lines.push(`      because: ${row.reason}`);
  }
  lines.push('', `Omitted rows (${omitted.length} of ${result.rows.length})`);
  if (omitted.length === 0) lines.push('  none');
  for (const row of omitted) {
    lines.push(`  [-] ${row.id}`);
    lines.push(`      because: ${row.reason}`);
  }
  if (result.unclassified.length > 0) {
    lines.push('', 'Unclassified paths (the full matrix is required until the mapping covers them)');
    for (const path of result.unclassified) lines.push(`  ${path}`);
  }
  if (result.exempt.length > 0) {
    lines.push('', 'Paths with no native effect');
    for (const group of groupExempt(result.exempt)) {
      lines.push(`  ${group.reason} (${group.paths.length}): ${samplePaths(group.paths)}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export function renderMarkdown(result, context) {
  const required = result.rows.filter((row) => row.required);
  const omitted = result.rows.filter((row) => !row.required);
  const lines = [
    '## QA',
    '',
    `Matrix chosen from the ${result.changed} paths changed in \`${context.range}\` with \`${context.command}\`.`,
    '',
    'Required rows:',
    '',
  ];
  if (required.length === 0) lines.push('- none');
  for (const row of required) {
    const shown = scope(row);
    const cause =
      row.causes.length > 0
        ? `Required by ${row.causes.map((entry) => `\`${entry.path}\``).join(', ')}.`
        : `Required because ${row.reason}.`;
    lines.push(`- **${row.id}**${shown ? ` (${shown})` : ''}: ${row.evidence}. ${cause}`);
  }
  if (result.unclassified.length > 0) {
    lines.push('', 'Unclassified paths, which require every row until the mapping covers them:', '');
    for (const path of result.unclassified) lines.push(`- \`${path}\``);
  }
  lines.push('', 'Omitted rows, with the diff-based reason:', '');
  if (omitted.length === 0) lines.push('- none');
  for (const row of omitted) lines.push(`- **${row.id}**: ${row.reason}.`);
  lines.push(
    '',
    'Every required row above still needs its attached automated summary or manual observation. Missing evidence is not a pass.',
  );
  return `${lines.join('\n')}\n`;
}

const versionOnlyManifest = /^packages\/[^/]+\/package\.json$/;

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** True when a package manifest diff moves the `version` field and nothing else. */
export function manifestDiffIsVersionOnly(diff) {
  const edits = diff.split('\n').filter((line) => /^[+-]/.test(line) && !/^(\+\+\+|---)/.test(line));
  return edits.length > 0 && edits.every((line) => /^[+-]\s*"version":/.test(line));
}

function readChanges(root, range) {
  const numstat = git(root, ['diff', '--numstat', '--no-renames', range]);
  const changes = [];
  for (const line of numstat.split('\n')) {
    if (line.trim() === '') continue;
    const [added, removed, path] = line.split('\t');
    const change = {
      path,
      added: added === '-' ? null : Number(added),
      removed: removed === '-' ? null : Number(removed),
    };
    if (
      versionOnlyManifest.test(path) &&
      manifestDiffIsVersionOnly(git(root, ['diff', '--unified=0', range, '--', path]))
    ) {
      change.exemptReason = 'version field only, the release candidate bump';
    }
    changes.push(change);
  }
  return changes;
}

function parseArguments(argv) {
  const options = { since: undefined, until: 'HEAD', format: 'checklist' };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--until' || argument === '--format') {
      const value = argv[index + 1];
      if (value === undefined) return { error: `${argument} needs a value` };
      options[argument === '--until' ? 'until' : 'format'] = value;
      index += 1;
    } else if (argument.startsWith('-')) {
      return { error: `unknown option ${argument}` };
    } else if (options.since === undefined) {
      options.since = argument;
    } else {
      return { error: `unexpected argument ${argument}` };
    }
  }
  if (options.since === undefined) return { error: 'missing the last published tag' };
  if (options.format !== 'checklist' && options.format !== 'markdown') {
    return { error: `unknown format ${options.format}` };
  }
  return { options };
}

function main(argv) {
  const { options, error } = parseArguments(argv);
  if (error) {
    process.stderr.write(`release-qa-matrix: ${error}\n${usage}\n`);
    process.exit(1);
  }
  const root = join(import.meta.dirname, '..');
  const range = `${options.since}..${options.until}`;
  let changes;
  try {
    changes = readChanges(root, range);
  } catch (gitError) {
    process.stderr.write(`release-qa-matrix: cannot read ${range}: ${gitError.message}\n`);
    process.exit(1);
  }
  const context = {
    range,
    command: `node scripts/release-qa-matrix.mjs ${options.since}${options.until === 'HEAD' ? '' : ` --until ${options.until}`}`,
  };
  const result = computeQaMatrix(changes);
  process.stdout.write(
    options.format === 'markdown' ? renderMarkdown(result, context) : renderChecklist(result, context),
  );
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
