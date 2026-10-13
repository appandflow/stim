import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const platforms = ['ios', 'android', 'macos'];
const requiredChecks = [
  'sourceExact',
  'runnerCompleted',
  'buildCompleted',
  'commandAudit',
  'processUnchanged',
  'revisionAndCountVisuallyVerified',
];
const requiredEvidence = [
  'events.jsonl',
  'commands.json',
  'source.diff',
  'proof/target.json',
  'proof/screen.png',
  'proof/coordinator-snapshot.txt',
  'proof/coordinator-process-before.json',
  'proof/coordinator-process-after.json',
];

function acceptedRun(directory, platform, arm) {
  const meta = readJson(join(directory, 'meta.json'));
  const record = readJson(join(directory, 'run.json'));
  const audit = readJson(join(directory, 'audit.json'));
  const cleanup = readJson(join(directory, 'cleanup.json'));
  if (
    record.cohort !== 'standalone-native-v1' ||
    meta.cohort !== record.cohort ||
    record.runId !== meta.runId ||
    record.runId !== basename(directory) ||
    record.platform !== platform ||
    meta.platform !== platform ||
    record.arm !== arm ||
    meta.arm !== arm ||
    record.source !== true ||
    record.invalidReasons?.length !== 0 ||
    record.runnerResult?.code !== 0 ||
    record.runnerResult?.timedOut !== false ||
    meta.runnerResult?.code !== 0 ||
    meta.runnerResult?.timedOut !== false ||
    audit.status !== 'accepted' ||
    audit.valid !== true ||
    cleanup.status !== 'complete' ||
    requiredChecks.some((name) => audit.checks?.[name] !== true)
  ) {
    throw new Error(`Native ${platform} ${arm} needs an accepted audit and completed cleanup`);
  }
  const seconds = (Date.parse(meta.finishedAt) - Date.parse(meta.dispatchAt)) / 1000;
  if (
    !Number.isFinite(seconds) ||
    seconds <= 0 ||
    Math.abs(record.elapsedSeconds - seconds) > 0.001 ||
    !Number.isFinite(record.elapsedSeconds)
  )
    throw new Error(`Native ${platform} ${arm} timing does not match its recorded turn`);
  if (requiredEvidence.some((name) => !audit.hashes?.[name])) throw new Error('Native audit evidence is incomplete');
  const root = realpathSync(directory);
  for (const [name, expected] of Object.entries(audit.hashes)) {
    const path = realpathSync(join(root, name));
    const rel = relative(root, path);
    if (
      isAbsolute(name) ||
      rel === '..' ||
      rel.startsWith(`..${sep}`) ||
      isAbsolute(rel) ||
      !/^[a-f0-9]{64}$/.test(expected) ||
      digest(path) !== expected
    )
      throw new Error(`Native audit evidence changed: ${name}`);
  }
  if (
    record.eventsSha256 !== audit.hashes['events.jsonl'] ||
    record.screenshotSha256 !== audit.hashes['proof/screen.png']
  )
    throw new Error('Native run evidence does not match its audit');
  return { directory, meta, record, audit, seconds };
}

export function exportNativeBenchmarks(campaignRoot, outputPath, proofDirectory) {
  const pairs = [];
  const copies = [];
  for (const platform of platforms) {
    const comparisonPath = join(campaignRoot, 'native', platform, 'comparison.json');
    if (!existsSync(comparisonPath)) continue;
    const comparison = readJson(comparisonPath);
    const runs = ['stim', 'control'].map((arm) => {
      const id = comparison.results?.[arm]?.runId;
      if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(id))
        throw new Error(`Missing native ${platform} ${arm} run`);
      return acceptedRun(join(campaignRoot, 'native', platform, 'results', id), platform, arm);
    });
    const [stim, control] = runs;
    for (const key of ['model', 'reasoningEffort', 'serviceTier']) {
      if (typeof stim.meta[key] !== 'string' || stim.meta[key] !== control.meta[key])
        throw new Error(`Native pair differs in ${key}`);
    }
    for (const key of [
      'fixtureCommit',
      'stimVersion',
      'stimCliSha256',
      'nodeVersion',
      'macosVersion',
      'macosBuild',
      'xcodeVersion',
      'xcodeBuild',
      'codexVersion',
    ]) {
      if (
        typeof stim.meta.provenance?.[key] !== 'string' ||
        stim.meta.provenance[key] !== control.meta.provenance?.[key]
      )
        throw new Error(`Native pair differs in ${key}`);
    }
    if (
      stim.meta.fixture.framework !== control.meta.fixture.framework ||
      stim.meta.compatibility.manifestSha256 !== control.meta.compatibility.manifestSha256
    )
      throw new Error('Native pair uses different fixture or compatibility tools');
    pairs.push({
      platform,
      backend: stim.meta.fixture.framework,
      model: stim.meta.model,
      reasoningEffort: stim.meta.reasoningEffort,
      requestedServiceTier: stim.meta.serviceTier,
      returnedServiceTier: 'unverified',
      samplePairs: 1,
      provenance: Object.fromEntries(
        [
          'stimVersion',
          'nodeVersion',
          'macosVersion',
          'macosBuild',
          'xcodeVersion',
          'xcodeBuild',
          'codexVersion',
          'fixtureCommit',
        ].map((key) => [key, stim.meta.provenance[key]]),
      ),
      timeReductionPercent: 100 * (1 - stim.seconds / control.seconds),
      runs: runs.map(({ directory, meta, record, audit, seconds }) => {
        const imageName = `${platform}-${record.arm}.png`;
        copies.push([join(directory, 'proof/screen.png'), join(proofDirectory, imageName)]);
        return {
          arm: record.arm,
          recordedOn: meta.dispatchAt.slice(0, 10),
          taskSeconds: seconds,
          usage: record.usage ?? null,
          proof: imageName,
          evidence: {
            recordSha256: digest(join(directory, 'run.json')),
            metadataSha256: digest(join(directory, 'meta.json')),
            auditSha256: digest(join(directory, 'audit.json')),
            cleanupSha256: digest(join(directory, 'cleanup.json')),
            eventsSha256: audit.hashes['events.jsonl'],
            proofSha256: audit.hashes['proof/screen.png'],
          },
        };
      }),
    });
  }
  if (!pairs.length) throw new Error('No accepted native benchmark pairs');
  const result = {
    schemaVersion: 1,
    cohort: 'standalone-native-v1',
    metric: 'dispatch-to-completed-task',
    machine: readJson(join(campaignRoot, 'targets.json')).machine,
    pairs,
  };
  mkdirSync(proofDirectory, { recursive: true });
  mkdirSync(dirname(outputPath), { recursive: true });
  for (const [source, target] of copies) copyFileSync(source, target);
  writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [campaignRoot, outputPath, proofDirectory] = process.argv.slice(2);
  if (!campaignRoot || !outputPath || !proofDirectory)
    throw new Error('Usage: export-native-benchmarks.mjs <campaign-root> <output-json> <proof-directory>');
  exportNativeBenchmarks(campaignRoot, outputPath, proofDirectory);
}
