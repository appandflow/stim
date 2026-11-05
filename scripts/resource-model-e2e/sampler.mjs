import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SAMPLE_COLUMNS, csvLine, sampleHost } from './platform.mjs';
import { run } from './shell.mjs';
import { parseJsonOutput, stimEnvironment } from './stim.mjs';

const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const csv = join(config.out, 'samples.csv');
const statusDir = join(config.out, 'status');
mkdirSync(statusDir, { recursive: true });
if (!existsSync(csv)) writeFileSync(csv, `${SAMPLE_COLUMNS.join(',')}\n`);

const identities = new Map();
const recordedAt = new Map();
const env = stimEnvironment(config.home, config.extraEnv ?? {});
let statusBusy = false;
let lastStatusAt = 0;
const state = { stopping: false };
const abort = new AbortController();
for (const name of ['SIGTERM', 'SIGINT']) {
  process.on(name, () => {
    state.stopping = true;
    abort.abort();
    setTimeout(() => process.exit(0), 500).unref();
  });
}

function parentAlive() {
  try {
    process.kill(config.parentPid, 0);
    return true;
  } catch {
    return false;
  }
}

function snapshotStatus() {
  statusBusy = true;
  lastStatusAt = Date.now();
  run(process.execPath, [config.cli, 'status', '--json'], {
    cwd: config.out,
    env,
    timeoutMs: 120_000,
    signal: abort.signal,
  })
    .then((result) => {
      const payload = result.code === 0 ? parseJsonOutput(result.stdout) : null;
      writeFileSync(
        join(statusDir, `${result.startedAt}.json`),
        JSON.stringify({ startedAt: result.startedAt, endedAt: result.endedAt, code: result.code, payload }),
      );
      return result.code;
    })
    .finally(() => (statusBusy = false));
}

while (!state.stopping && !existsSync(join(config.out, 'STOP')) && parentAlive()) {
  const started = Date.now();
  try {
    const stage = existsSync(join(config.out, 'stage')) ? readFileSync(join(config.out, 'stage'), 'utf8').trim() : '';
    appendFileSync(
      csv,
      `${csvLine(await sampleHost({ home: config.home, worktreePrefix: config.worktreePrefix, stage, volumes: config.volumes, identities, recordedAt, sinceMs: config.startedAt }))}\n`,
    );
  } catch (error) {
    appendFileSync(join(config.out, 'sampler.err'), `${new Date().toISOString()} ${error?.stack ?? error}\n`);
  }
  if (!statusBusy && Date.now() - lastStatusAt >= config.statusEveryMs) snapshotStatus();
  await new Promise((resolve) => setTimeout(resolve, Math.max(250, config.intervalMs - (Date.now() - started))));
}
