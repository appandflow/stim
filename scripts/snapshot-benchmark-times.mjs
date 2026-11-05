import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const seconds = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;

export function campaignTimings(label, datasets) {
  if (typeof label !== 'string' || !label.trim()) throw new Error('Campaign label is required');
  const models = ['gpt-5.6-luna', 'gpt-5.6-sol', 'sonnet', 'opus'];
  const platforms = ['ios', 'android'];
  const scenarios = ['javascript', 'native', 'launch-crash'];
  const arms = ['stim', 'control'];
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
      const platform =
        run.platform ?? dataset.platform ?? (/\biOS\b/.test(dataset.environment?.simulator ?? '') ? 'ios' : undefined);
      if (
        !models.includes(run.model) ||
        !platforms.includes(platform) ||
        !scenarios.includes(run.variant) ||
        !arms.includes(run.arm)
      ) {
        throw new Error('Unexpected campaign cell');
      }
      if (
        !run.valid ||
        !seconds(run.settingsReadySeconds) ||
        (run.variant === 'launch-crash' && !seconds(run.diagnosisSeconds))
      ) {
        throw new Error('Every campaign cell must have valid timings');
      }
      const key = [run.model, platform, run.variant, run.arm].join('/');
      if (cells.has(key)) throw new Error(`Duplicate campaign cell: ${key}`);
      cells.set(key, {
        model: run.model,
        platform,
        scenario: run.variant,
        arm: run.arm,
        settingsReadySeconds: run.settingsReadySeconds,
        ...(run.variant === 'launch-crash' ? { diagnosisSeconds: run.diagnosisSeconds } : {}),
      });
    }
  }
  if (cells.size !== models.length * platforms.length * scenarios.length * arms.length) {
    throw new Error(`Incomplete campaign: ${cells.size}/48 cells`);
  }
  return {
    schemaVersion: 1,
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
