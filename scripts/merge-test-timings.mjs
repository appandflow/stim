import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const shardNames = ['merge tests (shard 1/2)', 'merge tests (shard 2/2)'];
const seconds = (record) => (Date.parse(record.completed_at) - Date.parse(record.started_at)) / 1000;

export function measure(jobs) {
  const shards = shardNames.map((name) => jobs.find((job) => job.name === name));
  if (shards.some((job) => job?.conclusion !== 'success')) return null;
  const tests = shards.map((job) => job.steps.find((step) => step.name === 'Run Vitest shard'));
  if (tests.some((step) => step?.conclusion !== 'success')) return null;
  const testSeconds = tests.map(seconds);
  const runnerSeconds = shards.map(seconds);
  if ([...testSeconds, ...runnerSeconds].some((duration) => !Number.isFinite(duration) || duration <= 0)) return null;
  return {
    testSeconds,
    slowest: Math.max(...testSeconds),
    runnerSeconds: runnerSeconds.reduce((sum, n) => sum + n, 0),
  };
}

export function compare(slowest, history) {
  if (history.length < 3) return null;
  const sorted = history.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  const change = slowest - median;
  return { median, change, regression: change >= 60 && change / median >= 0.2 };
}

function run() {
  const { GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: runId, GITHUB_STEP_SUMMARY: summary } = process.env;
  const api = (path) => JSON.parse(execFileSync('gh', ['api', `repos/${repo}/actions/${path}`], { encoding: 'utf8' }));
  const jobs = (id, runAttempt) => api(`runs/${id}/attempts/${runAttempt}/jobs?per_page=100`).jobs;
  const current = measure(api(`runs/${runId}/jobs?filter=latest&per_page=100`).jobs);
  if (!current) throw new Error('No complete two-shard timing for this run.');

  const report = (lines) => appendFileSync(summary, `${lines.join('\n')}\n`);
  report([
    '### Merge queue test timings',
    '',
    `Vitest shard times: ${current.testSeconds.join(' s, ')} s. Total shard runner time: ${(current.runnerSeconds / 60).toFixed(1)} min.`,
  ]);
  const runNumber = Number(process.env.GITHUB_RUN_NUMBER);
  const recent = api('workflows/merge-gate.yml/runs?event=merge_group&status=success&per_page=15').workflow_runs;
  const history = [];
  for (const previous of recent) {
    if (previous.run_number >= runNumber || previous.run_attempt !== 1) continue;
    const timing = measure(jobs(previous.id, previous.run_attempt));
    if (timing) history.push(timing.slowest);
    if (history.length === 5) break;
  }
  const result = compare(current.slowest, history);
  if (!result) {
    report(['', `Collecting a baseline: ${history.length} of 3 comparable runs available.`]);
    return;
  }
  report([
    '',
    `Slowest shard: ${current.slowest} s. Median of ${history.length} recent successful runs: ${result.median} s (${result.change >= 0 ? '+' : ''}${result.change} s).`,
  ]);
  if (result.regression) {
    console.log(
      `::warning title=Merge queue test time regressed::The slowest shard took ${current.slowest} s, ${result.change} s above the recent median of ${result.median} s.`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run();
