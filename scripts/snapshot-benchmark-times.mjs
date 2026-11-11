import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { benchmarkMatrix, campaignModels, nativeMatrixPlatform, scenarioForRecord } from './agent-benchmark/matrix.mjs';

const seconds = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;

const READINESS_METRICS = [
  'First recorded agent activity to validated Settings screenshot',
  'First recorded agent activity to actionable diagnosis; repaired Settings screenshot reported separately',
];

function readinessCells(dataset) {
  if (!READINESS_METRICS.includes(dataset.primaryMetric)) throw new Error('Campaign must use first-activity timings');
  const fixturePrefix = dataset.fixture === 'bare' ? 'bare' : 'expo';
  return dataset.runs.map((run) => ({
    model: run.model,
    platform: `${fixturePrefix}-${run.platform}`,
    scenario: scenarioForRecord(run.variant),
    arm: run.arm,
    valid: run.valid,
    seconds: run.settingsReadySeconds,
    timingOrigin: 'first-agent-activity',
    diagnosisSeconds: run.diagnosisSeconds,
  }));
}

function nativeCells(dataset) {
  return dataset.pairs.flatMap((pair) =>
    pair.runs.map((run) => ({
      model: pair.model,
      platform: nativeMatrixPlatform(pair.platform, pair.backend),
      scenario: scenarioForRecord(pair.variant ?? 'standalone'),
      arm: run.arm,
      valid: true,
      seconds: run.taskSeconds,
      timingOrigin: 'dispatch-to-completed-task',
    })),
  );
}

export function campaignTimings(label, datasets, models = campaignModels({})) {
  if (typeof label !== 'string' || !label.trim()) throw new Error('Campaign label is required');
  const expected = new Set(
    models.flatMap((model) =>
      benchmarkMatrix()
        .filter((cell) => cell.status !== 'unsupported')
        .map((cell) => [model, cell.platform, cell.scenario, cell.arm].join('/')),
    ),
  );
  const cells = new Map();
  for (const dataset of datasets) {
    for (const run of dataset.pairs ? nativeCells(dataset) : readinessCells(dataset)) {
      const key = [run.model, run.platform, run.scenario, run.arm].join('/');
      if (!expected.has(key)) throw new Error('Unexpected campaign cell');
      if (
        !run.valid ||
        !seconds(run.seconds) ||
        (run.timingOrigin === 'first-agent-activity' && run.scenario === 'error-fix' && !seconds(run.diagnosisSeconds))
      ) {
        throw new Error('Every campaign cell must have valid timings');
      }
      if (cells.has(key)) throw new Error(`Duplicate campaign cell: ${key}`);
      cells.set(key, {
        model: run.model,
        platform: run.platform,
        scenario: run.scenario,
        arm: run.arm,
        timingOrigin: run.timingOrigin,
        seconds: run.seconds,
        ...(run.timingOrigin === 'first-agent-activity' && run.scenario === 'error-fix'
          ? { diagnosisSeconds: run.diagnosisSeconds }
          : {}),
      });
    }
  }
  if (cells.size !== expected.size) {
    throw new Error(`Incomplete campaign: ${cells.size}/${expected.size} cells`);
  }
  return {
    schemaVersion: 3,
    campaign: label,
    runs: [...cells.entries()].toSorted(([a], [b]) => a.localeCompare(b)).map(([, run]) => run),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [label, input, output] = process.argv.slice(2);
  if (!label || !input || !output)
    throw new Error('Usage: node scripts/snapshot-benchmark-times.mjs <campaign> <dataset-directory> <output.json>');
  const datasets = readdirSync(input)
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(join(input, name), 'utf8')));
  writeFileSync(output, `${JSON.stringify(campaignTimings(label, datasets), null, 2)}\n`, { flag: 'wx' });
}
