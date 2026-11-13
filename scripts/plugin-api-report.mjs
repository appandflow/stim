import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const stimCli = join(root, 'packages', 'stim-cli');
const notesFile = 'docs/releases/unreleased.md';

/**
 * Each public entry the gate freezes: `stim/plugin`, the package root `stim` (`createStim`), `stim/ci` and
 * `stim/cache-manifest`. `integersFrom` names the report whose integers a report without its own uses. `untagged` is the kind
 * that owns the root's lines, which come from no plugin kind's module: a change to them needs the `stim` integer.
 * `produced` names where the other side builds objects Stim reads: the interfaces a plugin implements, or the types a
 * caller passes to `createStim` and the client's methods.
 */
const REPORTS = [
  {
    name: 'stim/plugin',
    entry: 'plugin',
    source: 'src/plugin.ts',
    baselineFile: 'packages/stim-cli/plugin.api.txt',
    produced: 'implemented',
    note: 'The agent-driver and transport kinds are experimental in 2.x: their integers may go up in a minor release. Only cache-provider is frozen.',
  },
  {
    name: 'stim',
    entry: 'api',
    source: 'src/api.ts',
    baselineFile: 'packages/stim-cli/api.api.txt',
    untagged: 'stim',
    produced: 'arguments',
  },
  {
    name: 'stim/ci',
    entry: 'ci',
    source: '../ci/src/index.ts',
    baselineFile: 'packages/stim-cli/ci.api.txt',
    untagged: 'stim',
    produced: 'arguments',
    integersFrom: 'stim',
  },
  {
    name: 'stim/cache-manifest',
    entry: 'cache-manifest',
    source: 'src/cache-manifest.ts',
    baselineFile: 'packages/stim-cli/cache-manifest.api.txt',
    untagged: 'stim',
    produced: 'arguments',
    integersFrom: 'stim',
  },
];

const header = (report) => [
  `// The ${report.name} API report. Regenerate it with \`node scripts/plugin-api-report.mjs --update\`; see that script.`,
  ...(report.note ? [`// ${report.note}`] : []),
];

const RESET_HEADER = '// Reset once before 2.0.0 with --reset; a later change to these lines follows the integers.';

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

/**
 * Interfaces a plugin implements. A new required member breaks every plugin built before it, and so does one in an
 * object such an interface returns to Stim.
 */
const IMPLEMENTED = [
  'CacheProvider',
  'CacheProviderModule',
  'BuildCacheCapability',
  'FileCacheCapability',
  'Transport',
  'TransportModule',
  'HostedAgentDriver',
  'AgentDriverModule',
];

const TAG_MARK = '\u0000tag:';

const DECLARED =
  /^(?:export )?(?:declare )?(?:abstract )?(?:const|let|function|class|interface|type|enum|namespace) (\w+)/;

/** The tag a doc comment starts with, `internal` or `experimental`, or null. */
function leadingTag(comment) {
  const body = comment
    .replace(/^\/\*\*?/, '')
    .replace(/\*\/$/, '')
    .split('\n')
    .map((line) => line.replace(/^\s*\*?\s?/, ''))
    .join('\n')
    .trimStart();
  return /^@(internal|experimental)\b/.exec(body)?.[1] ?? null;
}

/**
 * Pushes and pops the parentheses of `text` on `stack`: `param` for one that opens a parameter list (after a name, a
 * `?` or a type argument list, or starting `(name:`, `(name?:`, `(...` or `()`), `group` for a grouping parenthesis
 * in a type such as `((A & {`.
 */
function trackParens(text, stack) {
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === ')') stack.pop();
    if (char !== '(') continue;
    const before = text.slice(0, index).trimEnd();
    const after = text.slice(index + 1);
    const param = /[\w?>]$/.test(before) || /^\s*(?:\)|\.\.\.|\w+\??:)/.test(after);
    stack.push(param ? 'param' : 'group');
  }
}

/**
 * One line per declaration member, prefixed by the plugin kind of the module that declares it (`[*]` for none) and its
 * top-level declaration. A line of a declaration's second or later union or intersection branch adds `@branch<n>` after
 * the declaration. A member adds `@@<depth>`, and `@@<depth>p` while it sits inside a parameter list, so a line says
 * whether it is in what a function takes or in what it returns. Comments, region markers, closing brackets and constant
 * values are removed, except that a doc comment that starts with `@internal` or `@experimental` keeps that tag before
 * the declaration or member it documents. Bundler suffixes such as `Foo$1` are dropped, and the export list is split
 * one name per line, so an addition reads as added lines only.
 */
export function normalizeDeclarations(text) {
  const entries = [];
  const declaredIn = new Map();
  let module = '*';
  let top = '';
  let branch = 0;
  const parens = [];
  let tag = '';
  const source = text
    .replace(/\r\n?/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => {
      const found = leadingTag(comment);
      return found ? `\n${TAG_MARK}${found}\n` : '';
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
    if (trimmed === '' || trimmed.startsWith('//')) continue;
    if (/^[\])}>;,]+$/.test(trimmed)) {
      trackParens(trimmed, parens);
      continue;
    }
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
    const head = () => (branch ? `${top} @branch${branch}` : top);
    if (line === trimmed && /^[\])}]/.test(trimmed)) {
      branch += 1;
      entries.push({ module, text: `${head()} @@0${parens.includes('param') ? 'p' : ''} ${tag}${trimmed}` });
    } else if (line === trimmed) {
      const declaration = trimmed.replace(/^(declare const \w+) = .*;$/, '$1;');
      const declared = DECLARED.exec(declaration);
      if (declared) declaredIn.set(declared[1], module);
      top = `${tag}${declaration}`;
      branch = 0;
      parens.length = 0;
      entries.push({ module, text: top });
    } else {
      const depth = Math.max(
        1,
        Math.floor(line.slice(0, line.length - trimmed.length).replace(/\t/g, '  ').length / 2),
      );
      entries.push({ module, text: `${head()} @@${depth}${parens.includes('param') ? 'p' : ''} ${tag}${trimmed}` });
    }
    trackParens(trimmed, parens);
    tag = '';
  }
  const lines = entries.map((entry) => `[${entry.module ?? declaredIn.get(entry.name) ?? '*'}] ${entry.text}`);
  return [...new Set(lines)].toSorted();
}

const LINE = /^\[([\w*-]+)\] (.*?)(?: @branch(\d+))?(?: @@(\d+)(p?) (.*))?$/;

/** A report line's parts: its kind, declaration text and name, branch, member depth, parameter flag and member text. */
function parseLine(line) {
  const [, kind, top, branch, depth, inParams, member] = LINE.exec(line) ?? [];
  const exported = /^export (?:type )?(\w+)/.exec(top ?? '');
  const declaration = (top ?? '').replace(/^@\w+ /, '');
  return {
    kind,
    top,
    name: exported ? null : (DECLARED.exec(declaration)?.[1] ?? null),
    exportName: exported?.[1] ?? null,
    internal: (top ?? '').startsWith('@internal ') || (member ?? '').startsWith('@internal '),
    branch: Number(branch ?? 0),
    depth: depth === undefined ? null : Number(depth),
    inParams: inParams === 'p',
    member: member === undefined ? null : member.replace(/^@\w+ /, ''),
  };
}

function identifiers(text) {
  return text.match(/\b[A-Za-z_]\w*\b/g) ?? [];
}

/** `text` without its balanced parenthesized groups, so the parameters of a function type drop out. */
function withoutParams(text) {
  let out = '';
  let level = 0;
  for (const char of text) {
    if (char === '(') level += 1;
    else if (char === ')') level = Math.max(0, level - 1);
    else if (level === 0) out += char;
  }
  return out;
}

/** For `name?(params): Ret;` the parameter text and what follows it; null for anything that is not a method line. */
function splitMethod(member) {
  const start = /^(?:readonly )?(?:\w+|\[[^\]]+\])\??(?:<[^(]*>)?\(/.exec(member);
  if (!start) return null;
  let level = 0;
  for (let index = start[0].length - 1; index < member.length; index += 1) {
    if (member[index] === '(') level += 1;
    else if (member[index] === ')' && --level === 0)
      return {
        before: member.slice(0, start[0].length),
        params: member.slice(start[0].length, index),
        after: member.slice(index),
      };
  }
  return null;
}

/** Splits `text` at top-level occurrences of `separator`, outside brackets and parentheses. */
function splitTopLevel(text, separator) {
  const parts = [];
  let level = 0;
  let current = '';
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if ('([{<'.includes(char)) level += 1;
    else if (')]}>'.includes(char) && text[index - 1] !== '=') level -= 1;
    if (level === 0 && text.startsWith(separator, index)) {
      parts.push(current.trim());
      current = '';
      index += separator.length - 1;
    } else current += char;
  }
  parts.push(current.trim());
  return parts;
}

/**
 * Declarations reachable from the report's exports without passing through a declaration or member tagged
 * `@internal`. Anything else exists only for internal members and carries no compatibility.
 */
function publicDeclarations(lines) {
  const parsed = lines.map(parseLine);
  const byName = new Map();
  for (const line of parsed) if (line.name) byName.set(line.name, [...(byName.get(line.name) ?? []), line]);
  const seen = new Set();
  const queue = parsed.filter((line) => line.exportName).map((line) => line.exportName);
  while (queue.length) {
    const name = queue.pop();
    if (seen.has(name) || !byName.has(name)) continue;
    const own = byName.get(name);
    if (own.every((line) => line.internal)) continue;
    seen.add(name);
    for (const line of own) {
      if (line.internal) continue;
      for (const word of identifiers(`${line.top} ${line.member ?? ''}`)) if (byName.has(word)) queue.push(word);
    }
  }
  return seen;
}

/**
 * Declarations whose objects the other side builds and Stim reads: what a plugin's implemented interfaces return, or
 * what a caller passes to `createStim` and the client's methods. A new required member of one breaks that other side.
 */
function producedDeclarations(lines, produced) {
  const parsed = lines.map(parseLine).filter((line) => !line.internal);
  const byName = new Map();
  for (const line of parsed) if (line.name) byName.set(line.name, [...(byName.get(line.name) ?? []), line]);
  const queue = [];
  if (produced === 'implemented') queue.push(...IMPLEMENTED);
  else if (produced === 'arguments') {
    for (const line of byName.get('StimClient') ?? []) {
      const method = line.depth === 1 && line.member ? splitMethod(line.member) : null;
      if (method) queue.push(...identifiers(method.params));
    }
    for (const line of parsed)
      if (line.depth === null && line.top.startsWith('declare function '))
        queue.push(...identifiers(splitMethod(line.top.replace(/^declare function /, ''))?.params ?? ''));
  }
  const seen = new Set();
  while (queue.length) {
    const name = queue.pop();
    if (seen.has(name) || !byName.has(name)) continue;
    seen.add(name);
    for (const line of byName.get(name)) {
      if (line.inParams) continue;
      let text = line.member ?? line.top.replace(/^.*?\b(?:interface|type|class) \w+/, '');
      const method = line.member ? splitMethod(line.member) : null;
      if (method) text = method.after;
      for (const word of identifiers(withoutParams(text))) if (byName.has(word)) queue.push(word);
    }
  }
  return seen;
}

/**
 * Declarations Stim builds and hands to a plugin: what the implemented interfaces' methods take, and the types that
 * reaches. A wider union there gives an existing plugin a value it never handled.
 */
function pluginInputs(lines) {
  const parsed = lines.map(parseLine).filter((line) => !line.internal);
  const byName = new Map();
  for (const line of parsed) if (line.name) byName.set(line.name, [...(byName.get(line.name) ?? []), line]);
  const queue = [];
  for (const name of IMPLEMENTED)
    for (const line of byName.get(name) ?? []) {
      if (line.inParams) queue.push(...identifiers(line.member ?? ''));
      const method = line.member && !line.inParams ? splitMethod(line.member) : null;
      if (method) queue.push(...identifiers(method.params));
    }
  const seen = new Set();
  while (queue.length) {
    const name = queue.pop();
    if (seen.has(name) || !byName.has(name)) continue;
    seen.add(name);
    for (const line of byName.get(name))
      for (const word of identifiers(
        `${line.top.replace(/^.*?\b(?:interface|type|class) \w+/, '')} ${line.member ?? ''}`,
      ))
        if (byName.has(word)) queue.push(word);
  }
  return seen;
}

/** Added lines that give an existing produced declaration a new required member. */
function memberName(member) {
  return /^(?:readonly )?(\w+|"[^"]*"|\[[^\]]+\])/.exec(member ?? '')?.[1] ?? null;
}

function requiredMembers(added, baseline, produced) {
  const parsed = baseline.map(parseLine);
  const existing = new Set(parsed.map((line) => `${line.name}@${line.branch}`));
  const members = new Set(parsed.map((line) => `${line.name}@${line.branch}@${line.depth}@${memberName(line.member)}`));
  return added.filter((raw) => {
    const line = parseLine(raw);
    if (!line.member || line.internal || line.inParams || !produced.has(line.name)) return false;
    if (!existing.has(`${line.name}@${line.branch}`)) return false;
    if (members.has(`${line.name}@${line.branch}@${line.depth}@${memberName(line.member)}`)) return false;
    return /^(?:readonly )?(?:\w+|"[^"]*"|\[[^\]]+\])[(:<]/.test(line.member);
  });
}

/** Whether `next` only widens `previous`: a union that gained alternatives, or a method that gained optional parameters. */
function widens(previous, next) {
  const before = parseLine(previous);
  const after = parseLine(next);
  if (before.kind !== after.kind || before.branch !== after.branch || before.depth !== after.depth) return false;
  if (before.inParams !== after.inParams) return false;
  if (before.member === null) {
    if (before.top === after.top) return false;
    const [leftName, leftType] = splitTopLevel(before.top.replace(/;$/, ''), ' = ');
    const [rightName, rightType] = splitTopLevel(after.top.replace(/;$/, ''), ' = ');
    return leftName === rightName && rightType !== undefined && unionWidens(leftType ?? '', rightType);
  }
  if (before.top !== after.top) return false;
  const left = splitMethod(before.member);
  const right = splitMethod(after.member);
  if (left && right) {
    if (left.before !== right.before || left.after !== right.after) return false;
    const leftParams = left.params === '' ? [] : splitTopLevel(left.params, ',');
    const rightParams = right.params === '' ? [] : splitTopLevel(right.params, ',');
    return (
      rightParams.length > leftParams.length &&
      leftParams.every((param, index) => param === rightParams[index]) &&
      rightParams.slice(leftParams.length).every((param) => /^\w+\?:/.test(param))
    );
  }
  const property = /^((?:readonly )?(?:\w+|"[^"]*"|\[[^\]]+\])\??: )(.*);$/;
  const leftProperty = property.exec(before.member);
  const rightProperty = property.exec(after.member);
  return Boolean(
    leftProperty &&
    rightProperty &&
    leftProperty[1] === rightProperty[1] &&
    unionWidens(leftProperty[2], rightProperty[2]),
  );
}

function unionWidens(left, right) {
  const before = new Set(splitTopLevel(left, ' | '));
  const after = new Set(splitTopLevel(right, ' | '));
  return after.size > before.size && [...before].every((alternative) => after.has(alternative));
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
 * What a new report means against the baseline: `same`; `additive` when it only adds lines, widens a union (except in
 * what Stim hands a plugin), adds optional parameters, or changes a line that carries no compatibility; `accepted` when it removes or changes other
 * lines, or adds a required member to an object the other side builds, and, for each kind that owns one of them, that
 * kind's integer went up and the unreleased notes' `## Removed (breaking)` section names the new integer as
 * `<kind> <integer>`; else `breaking`. A line carries no compatibility when it is tagged `@internal`, or belongs to a
 * declaration only `@internal` declarations or members reach. A line tagged `[*]` belongs to `untagged` when the
 * report names one; otherwise it needs at least one kind bumped. `integers` supplies the integers of a report that
 * declares none of its own. `needs` lists what is missing.
 */
export function apiReportVerdict({ baseline, current, notes, untagged, produced, integers }) {
  const removed = missing(baseline, current);
  const added = missing(current, baseline);
  const required = requiredMembers(added, baseline, producedDeclarations(current, produced));
  const reachable = publicDeclarations(baseline);
  const inputs = produced === 'implemented' ? pluginInputs(baseline) : new Set();
  const breaks = [
    ...removed.filter((line) => {
      if (/_API_VERSION: \d+;$/.test(line)) return false;
      const parsed = parseLine(line);
      if (parsed.internal || (parsed.name && !reachable.has(parsed.name))) return false;
      if (inputs.has(parsed.name)) return true;
      return !added.some((next) => widens(line, next));
    }),
    ...required,
  ];
  const versionChanged = removed.some((line) => /_API_VERSION: \d+;$/.test(line));
  if (breaks.length === 0 && !versionChanged)
    return {
      status: removed.length === 0 && added.length === 0 ? 'same' : 'additive',
      added,
      removed,
      required,
      needs: [],
    };
  const before = { ...integers?.before, ...kindIntegers(baseline) };
  const after = { ...integers?.after, ...kindIntegers(current) };
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

function reportLines(text) {
  return text.split('\n').filter((line) => line !== '' && !line.startsWith('//'));
}

function readFile(report) {
  const path = join(root, report.baselineFile);
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

export function readBaseline(report = REPORTS[0]) {
  return reportLines(readFile(report));
}

/** The text of `path` at `ref`, or null when that ref has no such file. */
function fileAt(ref, path) {
  const shown = spawnSync('git', ['show', `${ref}:${path}`], { cwd: root, encoding: 'utf8' });
  return shown.status === 0 ? shown.stdout : null;
}

/**
 * Whether a tree may reset its reports, judged from that tree's files (`read` returns a repository file's text or
 * null): only while `.github/next-version` names a later major than the published packages carry, the prerelease
 * line of a breaking release.
 */
export function resetAllowed(read) {
  const next = Number(/^(\d+)\./.exec(read('.github/next-version')?.trim() ?? '')?.[1]);
  const manifest = read('packages/stim-cli/package.json');
  const current = Number(/^(\d+)\./.exec(manifest ? JSON.parse(manifest).version : '')?.[1]);
  return Number.isInteger(next) && Number.isInteger(current) && next > current;
}

/**
 * Whether a branch's reports may land on a base: `before` is the base's committed baseline, `committed` the branch's,
 * `verdict` the branch's report against `before`, and `baseAllowsReset` whether the base's own files allow a reset.
 * A baseline may not drop the base's reset header, and a breaking change passes only as the one reset: the branch
 * records it, the base does not, and the base allows it.
 */
export function baseDecision({ before, committed, verdict, baseAllowsReset }) {
  if (before.includes(RESET_HEADER) && !committed.includes(RESET_HEADER))
    return { ok: false, reason: 'it drops the reset header the base baseline records' };
  if (verdict.status !== 'breaking') return { ok: true };
  if (committed.includes(RESET_HEADER) && !before.includes(RESET_HEADER) && baseAllowsReset)
    return { ok: true, reset: true };
  return { ok: false, reason: verdict.needs.join('; ') };
}

const RUN_UPDATE = 'node scripts/plugin-api-report.mjs --update';

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const update = process.argv.includes('--update');
  const reset = process.argv.includes('--reset');
  const baseIndex = process.argv.indexOf('--base');
  const base = baseIndex === -1 ? null : process.argv[baseIndex + 1];
  const notes = existsSync(join(root, notesFile)) ? readFileSync(join(root, notesFile), 'utf8') : '';
  const readHere = (path) => (existsSync(join(root, path)) ? readFileSync(join(root, path), 'utf8') : null);
  if (reset && !resetAllowed(readHere)) {
    console.error('--reset is only for the prerelease line of a major: .github/next-version names no later major.');
    process.exit(1);
  }
  const generated = new Map();
  for (const report of REPORTS) {
    const { name, baselineFile } = report;
    const current = await generateReport(report);
    const committed = readFile(report);
    generated.set(name, { current, baseline: reportLines(committed) });
    const source = report.integersFrom ? generated.get(report.integersFrom) : null;
    const integers = source && { before: kindIntegers(source.baseline), after: kindIntegers(source.current) };
    if (reset) {
      writeFileSync(join(root, baselineFile), `${[...header(report), RESET_HEADER, ...current].join('\n')}\n`);
      console.log(`Reset ${baselineFile}.`);
      continue;
    }
    const options = { notes, untagged: report.untagged, produced: report.produced, integers };
    const verdict = apiReportVerdict({ ...options, baseline: reportLines(committed), current });
    const listing = [
      ...verdict.removed.map((line) => `  - ${line}`),
      ...verdict.added.map((line) => `  + ${line}`),
    ].join('\n');
    const headed = [...header(report), ...(committed.includes(RESET_HEADER) ? [RESET_HEADER] : []), ...current];
    if (verdict.status === 'same' && update && `${headed.join('\n')}\n` !== committed) {
      writeFileSync(join(root, baselineFile), `${headed.join('\n')}\n`);
      console.log(`Updated the header of ${baselineFile}.`);
    } else if (verdict.status === 'same') {
      console.log(`${name} API report: ${current.length} lines, unchanged.`);
    } else if (verdict.status === 'breaking') {
      console.error(
        `${name} removes or changes lines of ${baselineFile}, or adds a required member to an object the other side builds:\n${listing}\n` +
          'A caller built against the old lines may break, so this change needs:\n' +
          verdict.needs.map((need) => `  * ${need}`).join('\n') +
          `\nBump the *_API_VERSION constant of each kind named in brackets ([*] lines need the kind they break), add the line to ${notesFile}, then run ${RUN_UPDATE} and commit ${baselineFile}. If the change was not meant to remove anything, restore the removed lines instead. In the stim/plugin report, lines tagged [*] come from a module that defines no single kind, an export under another name, or a file in a src/ subdirectory; they need at least one kind bumped. In the stim report they need the stim integer (STIM_API_VERSION).`,
      );
      process.exitCode = 1;
      continue;
    } else if (update) {
      writeFileSync(join(root, baselineFile), `${headed.join('\n')}\n`);
      console.log(`Updated ${baselineFile} (${verdict.status}):\n${listing}`);
    } else {
      console.error(
        `${name} differs from ${baselineFile} (${verdict.status === 'additive' ? 'additions only, no bump needed' : 'a bumped breaking change'}):\n${listing}\nRun ${RUN_UPDATE} and commit ${baselineFile}.`,
      );
      process.exitCode = 1;
      continue;
    }
    if (base === null) continue;
    const before = fileAt(base, baselineFile);
    if (before === null) continue;
    const againstBase = apiReportVerdict({ ...options, baseline: reportLines(before), current });
    const decision = baseDecision({
      before,
      committed,
      verdict: againstBase,
      baseAllowsReset: resetAllowed((path) => fileAt(base, path)),
    });
    if (decision.ok) {
      if (decision.reset)
        console.log(`${name}: ${baselineFile} records the one reset before the major against ${base}.`);
      continue;
    }
    console.error(`${name} cannot land on ${base}: ${decision.reason}.`);
    process.exitCode = 1;
  }
}
