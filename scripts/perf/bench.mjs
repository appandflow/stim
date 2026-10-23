#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, hostname, loadavg, tmpdir, totalmem, cpus } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { SCHEMA, machineId, parseTrace, scrubOutput, slug, summarizeRuns, summarizeTrace } from './lib.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const COMMAND_TIMEOUT_MS = 40 * 60_000;

const USAGE = `usage: node scripts/perf/bench.mjs (--version <x.y.z> | --cli <path to a built cli.mjs>) [options]

  --reps <n>              measured repetitions (default 3)
  --sha <ref>             commit of this repository whose apps/mobile the scenarios run (default HEAD)
  --scenarios <list>      comma list of warm,start,ios,android,stop (default all)
  --no-prime              skip the unmeasured first pass that fills the build caches
  --max-load <n>          refuse to start while the 1-minute load average is above n (default 80)
  --wait-minutes <n>      wait up to n minutes for the load to drop instead of refusing (default 0)
  --machine <id>          machine id (default: the model plus a short hash of the host name)
  --out <dir>             where to write the result (default ./perf-results)
  --publish               also commit the result to the perf-data branch of origin and push it
  --dry-run               print the plan and exit`;

const { values } = parseArgs({
  options: {
    version: { type: 'string' },
    cli: { type: 'string' },
    reps: { type: 'string', default: '3' },
    sha: { type: 'string', default: 'HEAD' },
    scenarios: { type: 'string', default: 'warm,start,ios,android,stop' },
    'no-prime': { type: 'boolean', default: false },
    'max-load': { type: 'string', default: '80' },
    'wait-minutes': { type: 'string', default: '0' },
    machine: { type: 'string' },
    out: { type: 'string', default: 'perf-results' },
    publish: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});
if (values.help || Boolean(values.version) === Boolean(values.cli)) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(values.help ? 0 : 2);
}

const reps = Number(values.reps);
const maxLoad = Number(values['max-load']);
const wanted = new Set(values.scenarios.split(',').map((name) => name.trim()));
const scratch = mkdtempSync(join(tmpdir(), 'stim-perf-'));
const log = (line) => process.stderr.write(`${line}\n`);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...options });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error };
}

function out(command, args, options) {
  const result = run(command, args, options);
  return result.status === 0 ? result.stdout.trim() : null;
}

function resolveCli() {
  if (values.cli) return resolve(values.cli);
  const prefix = join(scratch, `stim-${values.version}`);
  log(`installing stim@${values.version} into ${prefix}`);
  const install = run('npm', ['install', '--prefix', prefix, '--no-audit', '--no-fund', `stim@${values.version}`]);
  if (install.status !== 0) throw new Error(`npm install stim@${values.version} failed: ${install.stderr.trim()}`);
  return join(prefix, 'node_modules', 'stim', 'dist', 'cli.mjs');
}

function environment() {
  const sw = out('sw_vers', ['-productVersion']);
  const build = out('sw_vers', ['-buildVersion']);
  const xcode = out('xcodebuild', ['-version']);
  const model = out('sysctl', ['-n', 'hw.model']);
  return {
    id: values.machine ?? machineId(model, hostname()),
    model,
    cpu: out('sysctl', ['-n', 'machdep.cpu.brand_string']),
    cores: cpus().length,
    memoryGb: Math.round(totalmem() / 2 ** 30),
    os: sw ? `macOS ${sw}${build ? ` (${build})` : ''}` : process.platform,
    xcode: xcode ? xcode.split('\n').join(' ') : null,
    node: process.version,
  };
}

async function quietLoad() {
  const deadline = Date.now() + Number(values['wait-minutes']) * 60_000;
  for (;;) {
    const load = loadavg()[0];
    if (load <= maxLoad) return load;
    if (Date.now() >= deadline) {
      throw Object.assign(new Error(`1-minute load ${load.toFixed(1)} is above ${maxLoad}`), { code: 'LOAD' });
    }
    log(`load ${load.toFixed(1)} is above ${maxLoad}; waiting`);
    await new Promise((done) => setTimeout(done, 30_000));
  }
}

function statsSample(platform, startedMs, endedMs, wallMs) {
  try {
    const stats = JSON.parse(
      readFileSync(join(process.env.STIM_HOME ?? join(homedir(), '.stim'), 'stats.json'), 'utf8'),
    );
    const candidates = Object.values(stats.history ?? {}).flatMap((project) =>
      Object.values(project[platform] ?? {}).flat(),
    );
    const mine = candidates.filter((sample) => {
      const at = Date.parse(sample.at);
      return at >= startedMs - 1000 && at <= endedMs + 1000 && sample.durationMs <= wallMs + 1000;
    });
    return (
      mine.toSorted((a, b) => Math.abs(a.durationMs - wallMs) - Math.abs(b.durationMs - wallMs))[0]?.phases ?? null
    );
  } catch {
    return null;
  }
}

const STEPS = [
  { scenario: 'warm', group: 'warm', args: ['worktree', 'warm'] },
  { scenario: 'start', group: 'start', args: ['start'] },
  { scenario: 'ios-first', group: 'ios', args: ['ios'], platform: 'ios' },
  { scenario: 'ios-rerun', group: 'ios', args: ['ios'], platform: 'ios' },
  { scenario: 'android-first', group: 'android', args: ['android'], platform: 'android' },
  { scenario: 'android-rerun', group: 'android', args: ['android'], platform: 'android' },
  { scenario: 'stop', group: 'stop', args: ['stop'] },
].filter((step) => wanted.has(step.group));

function measure(cli, cwd, step, label) {
  const traceFile = join(scratch, `trace-${label}-${step.scenario}.json`);
  const loadBefore = loadavg()[0];
  const startedMs = Date.now();
  const began = performance.now();
  const result = run(process.execPath, [cli, ...step.args], {
    cwd,
    env: { ...process.env, STIM_TRACE: traceFile, STIM_NO_UPDATE_CHECK: '1' },
    timeout: COMMAND_TIMEOUT_MS,
  });
  const wallMs = Math.round(performance.now() - began);
  const endedMs = Date.now();
  const entry = {
    wallMs,
    exit: result.status ?? -1,
    loadBefore: Number(loadBefore.toFixed(2)),
    loadAfter: Number(loadavg()[0].toFixed(2)),
  };
  if (existsSync(traceFile)) {
    try {
      entry.trace = summarizeTrace(parseTrace(readFileSync(traceFile, 'utf8')));
    } catch (error) {
      entry.traceError = String(error.message).slice(0, 120);
    }
  }
  if (step.platform) {
    const phases = statsSample(step.platform, startedMs, endedMs, wallMs);
    if (phases) entry.statsPhases = phases;
  }
  if (entry.exit !== 0) {
    const detail = result.error ? String(result.error.message) : result.stderr || result.stdout;
    entry.error = scrubOutput(detail, { home: homedir(), tmp: tmpdir() });
  }
  return entry;
}

function pass(cli, sha, label) {
  const results = {};
  const tree = join(scratch, `wt-${label}`);
  const added = run('git', ['worktree', 'add', '--detach', tree, sha], { cwd: REPO });
  if (added.status !== 0) throw new Error(`git worktree add failed: ${added.stderr.trim()}`);
  const app = join(tree, 'apps', 'mobile');
  try {
    for (const step of STEPS) {
      log(`[${label}] ${step.scenario}`);
      results[step.scenario] = measure(cli, app, step, label);
      log(
        `[${label}] ${step.scenario}: ${(results[step.scenario].wallMs / 1000).toFixed(1)}s exit ${results[step.scenario].exit}`,
      );
    }
  } finally {
    const removed = run(process.execPath, [cli, 'worktree', 'remove'], { cwd: app });
    if (removed.status !== 0) {
      log(
        `stim worktree remove failed (${removed.stderr.trim().split('\n').at(-1)}); retrying with --force on the bench worktree`,
      );
      run(process.execPath, [cli, 'worktree', 'remove', '--force'], { cwd: app });
    }
    run('git', ['worktree', 'prune'], { cwd: REPO });
  }
  return results;
}

function publish(file, relative, url) {
  const clone = mkdtempSync(join(scratch, 'perf-data-'));
  const git = (args) => {
    const result = run('git', args, { cwd: clone });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
    return result.stdout.trim();
  };
  git(['init', '--quiet', '-b', 'perf-data']);
  git(['remote', 'add', 'origin', url]);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const exists =
      run('git', ['ls-remote', '--exit-code', '--heads', 'origin', 'perf-data'], { cwd: clone }).status === 0;
    if (exists) {
      git(['fetch', '--quiet', 'origin', 'perf-data']);
      git(['reset', '--quiet', '--hard', 'origin/perf-data']);
    }
    const target = join(clone, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(file));
    git(['add', relative]);
    git(['commit', '--quiet', '-m', `perf: ${relative}`]);
    const pushed = run('git', ['push', '--quiet', 'origin', 'perf-data'], { cwd: clone });
    if (pushed.status === 0) return;
    git(['reset', '--quiet', '--hard', 'HEAD~1']);
  }
  throw new Error('could not push the result to perf-data after three attempts');
}

async function main() {
  const sha = out('git', ['rev-parse', values.sha], { cwd: REPO });
  if (!sha) throw new Error(`${values.sha} is not a commit of this repository`);
  const plan = { reps, scenarios: STEPS.map((step) => step.scenario), sha };
  if (values['dry-run']) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return;
  }
  const cli = resolveCli();
  const version = out(process.execPath, [cli, '--version']);
  if (!version) throw new Error(`${cli} does not report a version`);
  const startedAt = new Date().toISOString();
  const startLoad = loadavg().map((load) => Number(load.toFixed(2)));
  await quietLoad();
  if (!values['no-prime']) {
    log('priming the caches with an unmeasured pass');
    pass(cli, sha, 'prime');
  }
  const scenarios = Object.fromEntries(STEPS.map((step) => [step.scenario, { runs: [] }]));
  for (let rep = 1; rep <= reps; rep += 1) {
    await quietLoad();
    for (const [name, entry] of Object.entries(pass(cli, sha, `rep${rep}`)))
      scenarios[name].runs.push({ rep, ...entry });
  }
  for (const scenario of Object.values(scenarios)) scenario.summary = summarizeRuns(scenario.runs);
  const dirty = Boolean(out('git', ['status', '--porcelain', '--', 'apps/mobile'], { cwd: REPO }));
  const label = values.version ?? `local-${sha.slice(0, 9)}`;
  const result = {
    schema: SCHEMA,
    startedAt,
    finishedAt: new Date().toISOString(),
    stim: {
      source: values.version ? 'npm' : 'path',
      label,
      version,
      traceSupport: Object.values(scenarios).some((scenario) => scenario.runs.some((each) => each.trace)),
    },
    repo: {
      sha,
      branch: out('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: REPO }),
      appDirty: dirty,
    },
    machine: environment(),
    config: { reps, primed: !values['no-prime'], app: 'apps/mobile', maxLoad },
    load: { start: startLoad, end: loadavg().map((load) => Number(load.toFixed(2))) },
    scenarios,
    skipped: [
      {
        scenario: 'bare-ios-rerun',
        reason: 'no bare React Native fixture is checked in; test/e2e generates one from the network',
      },
      {
        scenario: 'bare-android-rerun',
        reason: 'no bare React Native fixture is checked in; test/e2e generates one from the network',
      },
      ...['warm', 'start', 'ios', 'android', 'stop']
        .filter((group) => !wanted.has(group))
        .map((group) => ({ scenario: group, reason: 'not selected' })),
    ],
  };
  const stamp = startedAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const relative = join('runs', result.machine.id, `${stamp}-${slug(label)}.json`);
  const file = join(resolve(values.out), relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
  log(`wrote ${file}`);
  if (values.publish) {
    publish(file, relative, out('git', ['remote', 'get-url', 'origin'], { cwd: REPO }));
    log('pushed to origin perf-data');
  }
  process.stdout.write(`${file}\n`);
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = error.code === 'LOAD' ? 3 : 1;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
