import { validateDeviceSlot } from '../device-slots.ts';
import chalk from 'chalk';
import type { ChalkInstance } from 'chalk';
import type { Command } from 'commander';
import { realpathSync } from 'node:fs';
import { relative, sep } from 'node:path';
import { isPathPrefix, loadConfig } from '../config.ts';
import { findProjectRoot } from '../project.ts';
import { workspaceLogsDir } from '../paths.ts';
import { LEVELS, SOURCES } from '../ndjson.ts';
import type { NdjsonRecord } from '../ndjson.ts';
import { buildCriteria, compileGrep, fileSizes, followLogs, logFiles, parseSince, queryLogs } from '../logs-query.ts';
import { errorDiagnostics } from '../error-diagnostics.ts';
import { launchErrorPreview } from '../launch-error-preview.ts';
import { readWorkspaceState } from '../supervisor/state.ts';
import { captureWorkspaceCrashes } from '../native-crash.ts';

const LEVEL_WIDTH = 5;
const SRC_WIDTH = 6;
const INDENT = '    ';

function padTimePart(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

interface StackFrame {
  file?: string;
  line?: number;
  column?: number;
  fn?: string;
}

export function formatTime(ts: unknown): string {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return '--:--:--.---';
  const d = new Date(ts);
  return `${padTimePart(d.getHours())}:${padTimePart(d.getMinutes())}:${padTimePart(d.getSeconds())}.${padTimePart(d.getMilliseconds(), 3)}`;
}

export function formatStackFrame(frame: StackFrame | null | undefined): string | null {
  if (!frame || typeof frame !== 'object') return null;
  const where = [frame.file, frame.line, frame.column]
    .filter((p) => p !== undefined && p !== null && p !== '')
    .join(':');
  if (frame.fn && where) return `at ${frame.fn} (${where})`;
  if (frame.fn) return `at ${frame.fn}`;
  if (where) return `at ${where}`;
  return null;
}

export function formatRecord(
  record: Partial<NdjsonRecord> | null | undefined,
  { paint }: { paint?: (t: string) => string } = {},
): string {
  const colour = paint || ((t: string) => t);
  const level = String(record?.level ?? '').padEnd(LEVEL_WIDTH);
  const src = String(record?.src ?? '').padEnd(SRC_WIDTH);
  const msg = record?.msg === undefined || record?.msg === null ? '' : String(record.msg);
  const [first, ...rest] = msg.split('\n');
  const lines = [`${formatTime(record?.ts)} ${colour(level)} ${src} ${first}`];
  for (const line of rest) lines.push(`${INDENT}${line}`);
  for (const frame of (Array.isArray(record?.stack) ? record.stack : []) as StackFrame[]) {
    const rendered = formatStackFrame(frame);
    if (rendered) lines.push(`${INDENT}${rendered}`);
  }
  return lines.join('\n');
}

export function parseTail(value: unknown): { n?: number; error?: string } {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return { n: value };
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) {
    return { error: `Invalid --tail value ${JSON.stringify(value)}. Use a non-negative whole number, e.g. --tail 50.` };
  }
  return { n: parseInt(value.trim(), 10) };
}

interface SourcesResult {
  sources?: string[];
  error?: string;
}

export function validateSources(sources: string | string[] | undefined | null): SourcesResult {
  if (sources === undefined || sources === null) return { sources: undefined };
  const list = Array.isArray(sources) ? sources : [sources];
  if (list.includes('all')) return { sources: [...SOURCES] };
  const unknown = list.filter((s) => !SOURCES.includes(s));
  if (unknown.length > 0) {
    return {
      error: `Unknown --source value(s): ${unknown.join(', ')}. Use one or more of: ${SOURCES.join(', ')}, or all.`,
    };
  }
  return { sources: list };
}

interface LevelResult {
  level?: string;
  error?: string;
}

export function validateLevel(level: string): LevelResult {
  if (LEVELS.includes(level)) return { level };
  return { error: `Invalid --level value ${JSON.stringify(level)}. Use one of: ${LEVELS.join(', ')}.` };
}

export const ERRORS_PRINT_CAP = 20;

function nearestRegisteredLogsProject(root: string, candidates: string[]): string | null {
  return (
    candidates
      .filter((candidate) => candidate !== root && isPathPrefix(root, candidate))
      .toSorted((a, b) => {
        const depth = (path: string) => relative(root, path).split(sep).length;
        return depth(a) - depth(b) || a.length - b.length || a.localeCompare(b);
      })[0] ?? null
  );
}

function registeredDescendantWithLogs(root: string): string | null {
  const candidates = Object.keys(loadConfig()?.projects ?? {}).flatMap((path) => {
    try {
      const canonical = realpathSync(path);
      return logFiles(workspaceLogsDir(canonical)).length > 0 ? [canonical] : [];
    } catch {
      return [];
    }
  });
  return nearestRegisteredLogsProject(root, [...new Set(candidates)]);
}

function requireLogsWorkspace(root: string, dir: string): void {
  if (logFiles(dir).length > 0) return;
  const descendant = registeredDescendantWithLogs(root);
  const remedy = descendant
    ? ` The nearest registered app with logs is ${descendant}; run this command from there.`
    : ' Run `stim start`, `stim ios`, or `stim android` in the app first.';
  fail(`STIM_NO_PROJECT: No Stim workspace has run in ${root}.${remedy}`);
}

const LEVEL_COLOURS: Record<string, ChalkInstance> = {
  debug: chalk.dim,
  info: chalk.reset,
  warn: chalk.yellow,
  error: chalk.red,
  fatal: chalk.bgRed,
};

interface LogsOptions {
  slot?: string;
  source?: string | string[];
  level?: string;
  since?: string;
  grep?: string;
  tail?: string | number;
  errors?: boolean;
  follow?: boolean;
  json?: boolean;
}

export default function logsCommand(program: Command): void {
  program
    .command('logs')
    .description(
      "Query this workspace's merged NDJSON log timeline (bundler, client, device, build). Prints and exits; an existing timeline with nothing matching is a successful, empty result. Use --follow to stream.",
    )
    .option('--slot <name>', 'Only records attributed to this device slot', validateDeviceSlot)
    .option('--source <s...>', 'Only these sources: metro, client, device, build, or all')
    .option('--level <l>', `Minimum level: ${LEVELS.join(', ')}`)
    .option('--since <d>', 'Only records newer than this, e.g. 30s, 5m, 2h')
    .option('--grep <re>', 'Only records whose message matches this regular expression')
    .option('--tail <n>', 'Only the last n matching records')
    .option(
      '--errors',
      'Errors and fatals since the last marker, from metro, client and build, plus confirmed native app-crash reports. Add --source device or --source all for general device errors.',
    )
    .option('--follow', 'Keep streaming new records until interrupted')
    .option('--json', 'Emit the raw records, one per line (valid NDJSON; zero matches is zero bytes, exit 0)')
    .action(async (opts: LogsOptions) => {
      const root = findProjectRoot(process.cwd());
      if (!root) {
        console.error(chalk.red('Not in a React Native project (no package.json found).'));
        process.exit(1);
      }
      const dir = workspaceLogsDir(root);

      let sources: string[] | undefined;
      if (opts.source !== undefined) {
        const checked = validateSources(opts.source);
        if (checked.error) fail(checked.error);
        sources = checked.sources;
      }

      let minLevel: string | undefined;
      if (opts.level !== undefined) {
        const checked = validateLevel(opts.level);
        if (checked.error) fail(checked.error);
        minLevel = checked.level;
      }

      if (opts.since !== undefined) {
        const parsed = parseSince(opts.since);
        if (parsed.error) fail(parsed.error);
      }

      let tail: number | undefined;
      if (opts.tail !== undefined) {
        const parsed = parseTail(opts.tail);
        if (parsed.error) fail(parsed.error);
        tail = parsed.n;
      }

      if (opts.grep !== undefined) {
        const compiled = compileGrep(opts.grep);
        if (compiled.error) fail(compiled.error);
      }

      requireLogsWorkspace(root, dir);

      const query = {
        slot: opts.slot,
        dir,
        sources,
        minLevel,
        since: opts.since,
        grep: opts.grep,
        tail,
        errorsOnly: Boolean(opts.errors),
        errorContext: Boolean(opts.errors && !opts.json && !opts.follow),
      };

      const emit = (record: NdjsonRecord) => {
        if (opts.json) {
          console.log(JSON.stringify(record));
          return;
        }
        const rendered = {
          ...record,
          msg: launchErrorPreview([record], root, { full: true }).join('\n'),
          stack: undefined,
        };
        console.log(formatRecord(rendered, { paint: record?.level ? LEVEL_COLOURS[record.level] : undefined }));
      };

      const offsets = opts.follow ? fileSizes(dir) : null;

      captureWorkspaceCrashes(root, dir);
      const rawRecords = queryLogs(query);
      const supervisorPort = readWorkspaceState(root)?.supervisor?.port;
      const records = opts.json
        ? rawRecords
        : await errorDiagnostics(rawRecords, {
            root,
            logsDir: dir,
            port: typeof supervisorPort === 'number' ? supervisorPort : null,
            allowRequest: true,
          });
      const errorCount = records.filter((record) => record.errorContext !== true).length;
      let seenErrors = 0;
      const capped =
        opts.errors && !opts.json && tail === undefined && errorCount > ERRORS_PRINT_CAP
          ? records.filter((record) => {
              if (record.errorContext === true) return seenErrors <= ERRORS_PRINT_CAP;
              seenErrors += 1;
              return seenErrors <= ERRORS_PRINT_CAP;
            })
          : records;
      for (const record of capped) emit(record);
      const hidden = errorCount - capped.filter((record) => record.errorContext !== true).length;
      if (hidden > 0) {
        console.log(
          chalk.dim(
            `Showing ${ERRORS_PRINT_CAP} of ${errorCount} matching error records; ${hidden} not shown. Add --tail ${rawRecords.length} to include all captured records before grouping, or --json for raw records. Stacks are shown in full.`,
          ),
        );
      }

      if (!opts.follow) {
        if (records.length === 0 && !opts.json) {
          console.error(chalk.dim(`No matching log records in ${dir}`));
        }
        return;
      }

      const criteria = buildCriteria({
        slot: opts.slot,
        sources,
        minLevel,
        since: opts.since,
        grep: opts.grep,
        errorsOnly: Boolean(opts.errors),
      });
      const stop = followLogs({ dir, offsets, criteria, onRecord: emit });
      const finish = () => {
        stop();
        process.exit(0);
      };
      process.on('SIGINT', finish);
      process.on('SIGTERM', finish);
    });
}

function fail(message: string): never {
  console.error(chalk.red(message));
  process.exit(1);
}
