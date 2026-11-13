import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const seconds = (record) => (Date.parse(record.completed_at) - Date.parse(record.started_at)) / 1000;

const metrics = {
  merge: {
    workflow: 'merge-gate.yml',
    filters: 'event=merge_group',
    steps: [1, 2].map((shard) => [`merge tests (shard ${shard}/2)`, 'Run Vitest shard']),
    title: 'Merge queue test timings',
    subject: 'Slowest shard',
    duration: (values) => Math.max(...values),
    details: (values) => `Vitest shard times: ${values.join(' s, ')} s.`,
  },
  main: {
    workflow: 'ci.yml',
    filters: 'event=push&branch=main',
    steps: ['Unit tests (vitest)', 'Integration tests (vitest)'].map((step) => ['test (node 24)', step]),
    title: 'Main test timings',
    subject: 'Node 24 test time',
    duration: ([unit, integration]) => unit + integration,
    details: ([unit, integration]) => `Node 24 unit: ${unit} s. Integration: ${integration} s.`,
  },
};

export function measure(jobs, mode, current = false) {
  const { steps, duration } = metrics[mode];
  const matched = steps.map(([name]) => jobs.find((job) => job.name === name));
  if (matched.some((job) => !job || (job.conclusion !== 'success' && !(current && job.status === 'in_progress')))) {
    return null;
  }
  const tests = steps.map(([, name], index) => matched[index].steps.find((step) => step.name === name));
  if (tests.some((step) => step?.conclusion !== 'success')) return null;
  const testSeconds = tests.map(seconds);
  const runnerSeconds = mode === 'merge' ? matched.map(seconds) : [];
  if ([...testSeconds, ...runnerSeconds].some((value) => !Number.isFinite(value) || value <= 0)) return null;
  return {
    testSeconds,
    duration: duration(testSeconds),
    runnerSeconds: runnerSeconds.reduce((sum, n) => sum + n, 0),
  };
}

export function compare(duration, history) {
  if (history.length < 3) return null;
  const sorted = history.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  const change = duration - median;
  return { median, change, regression: change >= 60 && change / median >= 0.2 };
}

function run() {
  const mode = process.argv[2];
  const { workflow, filters, title, subject, details } = metrics[mode];
  const { GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: runId, GITHUB_STEP_SUMMARY: summary } = process.env;
  const api = (path) => JSON.parse(execFileSync('gh', ['api', `repos/${repo}/actions/${path}`], { encoding: 'utf8' }));
  const jobs = (id, runAttempt) => api(`runs/${id}/attempts/${runAttempt}/jobs?per_page=100`).jobs;
  const current = measure(api(`runs/${runId}/jobs?filter=latest&per_page=100`).jobs, mode, mode === 'main');
  if (!current) throw new Error('No complete test timing for this run.');

  const report = (lines) => appendFileSync(summary, `${lines.join('\n')}\n`);
  report([`### ${title}`, '', details(current.testSeconds)]);
  if (mode === 'merge') report([`Total shard runner time: ${(current.runnerSeconds / 60).toFixed(1)} min.`]);
  const runNumber = Number(process.env.GITHUB_RUN_NUMBER);
  const recent = api(`workflows/${workflow}/runs?${filters}&status=success&per_page=15`).workflow_runs;
  const history = [];
  for (const previous of recent) {
    if (previous.run_number >= runNumber || previous.run_attempt !== 1) continue;
    const timing = measure(jobs(previous.id, previous.run_attempt), mode);
    if (timing) history.push(timing.duration);
    if (history.length === 5) break;
  }
  const result = compare(current.duration, history);
  if (!result) {
    report(['', `Collecting a baseline: ${history.length} of 3 comparable runs available.`]);
    return;
  }
  report([
    '',
    `${subject}: ${current.duration} s. Median of ${history.length} recent successful runs: ${result.median} s (${result.change >= 0 ? '+' : ''}${result.change} s).`,
  ]);
  if (result.regression) {
    console.log(
      `::warning title=${title} regression::${subject}: ${current.duration} s, ${result.change} s above the recent median of ${result.median} s.`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run();
