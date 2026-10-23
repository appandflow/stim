#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULTS, compareRuns, formatComparison, groupByMachine } from './lib.mjs';

const USAGE = `usage: node scripts/perf/compare.mjs [--data <perf-data checkout>] [--machine <id>] [--scenario <name>]
         [--threshold 0.1] [--min-delta-ms 250] [--max-load-diff 20] [--json]

Compares, per machine, the latest run on the perf-data branch with the run before it. A scenario is flagged
REGRESSION when its median wall time grows by more than --threshold and --min-delta-ms. Runs taken under very
different load are not compared. Without --data it clones origin's perf-data branch.`;

const { values } = parseArgs({
  options: {
    data: { type: 'string' },
    machine: { type: 'string' },
    scenario: { type: 'string' },
    threshold: { type: 'string', default: String(DEFAULTS.threshold) },
    'min-delta-ms': { type: 'string', default: String(DEFAULTS.minDeltaMs) },
    'max-load-diff': { type: 'string', default: String(DEFAULTS.maxLoadDiff) },
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});
if (values.help) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

function jsonFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '.git' ? [] : jsonFiles(path);
    return entry.name.endsWith('.json') ? [path] : [];
  });
}

let clone = null;
try {
  let data = values.data;
  if (!data) {
    const url = git(['remote', 'get-url', 'origin']);
    clone = mkdtempSync(join(tmpdir(), 'stim-perf-data-'));
    const cloned = spawnSync('git', ['clone', '--quiet', '--depth', '1', '--branch', 'perf-data', url, clone], {
      encoding: 'utf8',
    });
    if (cloned.status !== 0) throw new Error(`cannot read the perf-data branch of origin: ${cloned.stderr.trim()}`);
    data = clone;
  }
  const runs = existsSync(join(data, 'runs'))
    ? jsonFiles(join(data, 'runs')).map((file) => JSON.parse(readFileSync(file, 'utf8')))
    : [];
  const options = {
    threshold: Number(values.threshold),
    minDeltaMs: Number(values['min-delta-ms']),
    maxLoadDiff: Number(values['max-load-diff']),
  };
  const results = [];
  for (const [machine, list] of groupByMachine(runs)) {
    if (values.machine && machine !== values.machine) continue;
    const latest = list.at(-1);
    const previous = list.at(-2);
    if (!previous) {
      results.push({ machine, message: `${machine}: one run, nothing to compare against` });
      continue;
    }
    const result = compareRuns(latest, previous, options);
    if (values.scenario) result.rows = result.rows.filter((row) => row.scenario === values.scenario);
    results.push({ machine, latest, previous, result });
  }
  if (values.json) {
    process.stdout.write(
      `${JSON.stringify(results.map(({ machine, latest, previous, result, message }) => ({ machine, latest: latest?.id, previous: previous?.id, message, ...result })))}\n`,
    );
  } else if (results.length === 0) {
    process.stdout.write('no runs found\n');
  } else {
    process.stdout.write(
      `${results.map((entry) => entry.message ?? formatComparison(entry.machine, entry.latest, entry.previous, entry.result)).join('\n\n')}\n`,
    );
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
} finally {
  if (clone) rmSync(clone, { recursive: true, force: true });
}
