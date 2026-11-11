import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { benchmarkMatrix, campaignModels, scenarioForRecord } from './agent-benchmark/matrix.mjs';

const seconds = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;

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
    if (
      ![
        'First recorded agent activity to validated Settings screenshot',
        'First recorded agent activity to actionable diagnosis; repaired Settings screenshot reported separately',
      ].includes(dataset.primaryMetric)
    ) {
      throw new Error('Campaign must use first-activity timings');
    }
    for (const run of dataset.runs) {
      const platform = run.matrixPlatform ?? (run.platform ? `expo-${run.platform}` : undefined);
      const scenario = scenarioForRecord(run.variant);
      const key = [run.model, platform, scenario, run.arm].join('/');
      if (!expected.has(key)) throw new Error('Unexpected campaign cell');
      if (
        !run.valid ||
        !seconds(run.settingsReadySeconds) ||
        (scenario === 'error-fix' && !seconds(run.diagnosisSeconds))
      ) {
        throw new Error('Every campaign cell must have valid timings');
      }
      if (cells.has(key)) throw new Error(`Duplicate campaign cell: ${key}`);
      cells.set(key, {
        model: run.model,
        platform,
        scenario,
        arm: run.arm,
        settingsReadySeconds: run.settingsReadySeconds,
        ...(scenario === 'error-fix' ? { diagnosisSeconds: run.diagnosisSeconds } : {}),
      });
    }
  }
  if (cells.size !== expected.size) {
    throw new Error(`Incomplete campaign: ${cells.size}/${expected.size} cells`);
  }
  return {
    schemaVersion: 2,
    campaign: label,
    timingOrigin: 'first-agent-activity',
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
