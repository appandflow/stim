import { createHash } from 'node:crypto';

export const SCHEMA = 1;

export function median(values) {
  if (values.length === 0) return null;
  const sorted = values.toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** The events of a STIM_TRACE file, which is a JSON array with one event per line and no closing bracket. */
export function parseTrace(text) {
  const body = text.trimEnd().replace(/,$/, '');
  return JSON.parse(body.endsWith(']') ? body : `${body}]`);
}

const sumBy = (events, name) => {
  const out = {};
  for (const event of events) out[event[name]] = (out[event[name]] ?? 0) + event.dur / 1000;
  return Object.fromEntries(Object.entries(out).map(([key, ms]) => [key, Math.round(ms)]));
};

/** Milliseconds per build phase and named span, the child process total, and the command span of a trace. */
export function summarizeTrace(events) {
  const spans = events.filter((event) => event.ph === 'X' && Number.isFinite(event.dur));
  const exec = spans.filter((event) => event.cat === 'exec');
  const command = spans.find((event) => event.cat === 'command');
  return {
    commandMs: command ? Math.round(command.dur / 1000) : null,
    phases: sumBy(
      spans.filter((event) => event.cat === 'phase'),
      'name',
    ),
    spans: sumBy(
      spans.filter((event) => event.cat === 'span'),
      'name',
    ),
    exec: { count: exec.length, ms: Math.round(exec.reduce((total, event) => total + event.dur, 0) / 1000) },
  };
}

/** Wall times of the repetitions that succeeded, and what to say about the rest. */
export function summarizeRuns(runs) {
  const good = runs.filter((run) => run.exit === 0).map((run) => run.wallMs);
  const mid = median(good);
  return {
    n: runs.length,
    failures: runs.length - good.length,
    medianMs: mid,
    minMs: good.length ? Math.min(...good) : null,
    maxMs: good.length ? Math.max(...good) : null,
    spread: mid ? (Math.max(...good) - Math.min(...good)) / mid : null,
  };
}

const rangeMs = (summary) => (summary.maxMs ?? 0) - (summary.minMs ?? 0);

const peakLoad = (scenario) => Math.max(0, ...scenario.runs.map((each) => each.loadBefore).filter(Number.isFinite));

const loadOf = (scenarios) =>
  median(scenarios.flatMap((scenario) => scenario.runs.map((each) => each.loadBefore).filter(Number.isFinite)));

/** The load a run was taken under: the median 1-minute load average before its commands started. */
function runLoad(run) {
  return loadOf(Object.values(run.scenarios ?? {}));
}

export const DEFAULTS = {
  threshold: 0.1,
  minDeltaMs: 250,
  maxLoadDiff: 20,
  loadRatio: 2,
  highLoad: 80,
  noisySpread: 0.5,
  confirmReps: 5,
};

/**
 * Why two runs cannot be compared, or null. They are refused when their loads differ by more than `maxLoadDiff` and
 * by more than `loadRatio` times: a timing taken under twice the load says nothing about the code.
 */
export function loadRefusal(a, b, { maxLoadDiff, loadRatio } = DEFAULTS) {
  if (a === null || b === null) return null;
  const high = Math.max(a, b);
  const low = Math.max(Math.min(a, b), 1);
  return high - Math.min(a, b) > maxLoadDiff && high / low > loadRatio
    ? `load differs too much (${a.toFixed(1)} against ${b.toFixed(1)})`
    : null;
}

const COMPARED_ENVIRONMENT = ['model', 'os', 'xcode', 'node'];

/** One row per scenario of `latest`, against the same scenario of `previous`. Deltas are medians. */
export function compareRuns(latest, previous, options = {}) {
  const config = { ...DEFAULTS, ...options };
  const loadLatest = runLoad(latest);
  const loadPrevious = runLoad(previous);
  const notes = [];
  const unlike =
    latest.config?.primed !== previous.config?.primed ? 'one run primed the build caches and the other did not' : null;
  if (unlike) notes.push(`not compared: ${unlike}`);
  for (const [which, load] of [
    ['latest', loadLatest],
    ['previous', loadPrevious],
  ]) {
    if (load !== null && load > config.highLoad) notes.push(`${which} run was taken at load ${load.toFixed(1)}`);
  }
  if (latest.repo?.sha && previous.repo?.sha && latest.repo.sha !== previous.repo.sha) {
    notes.push(`app source differs (${latest.repo.sha.slice(0, 9)} against ${previous.repo.sha.slice(0, 9)})`);
  }
  const changed = COMPARED_ENVIRONMENT.filter((key) => latest.machine?.[key] !== previous.machine?.[key]);
  if (changed.length) notes.push(`machine differs: ${changed.join(', ')}`);
  const rows = [];
  let refused = Boolean(unlike);
  for (const [name, scenario] of Object.entries(latest.scenarios ?? {})) {
    const after = summarizeRuns(scenario.runs);
    const before = previous.scenarios?.[name] ? summarizeRuns(previous.scenarios[name].runs) : null;
    const row = { scenario: name, before, after, deltaPct: null, status: 'ok' };
    rows.push(row);
    const refusal =
      unlike ?? loadRefusal(loadOf([scenario]), loadOf([previous.scenarios?.[name] ?? { runs: [] }]), config);
    if (!before || before.medianMs === null) row.status = 'no previous';
    else if (after.medianMs === null) row.status = 'failed';
    else if (refusal) {
      row.status = 'not compared';
      if (!unlike) {
        refused = true;
        notes.push(`${name} not compared: ${refusal}`);
      }
    } else {
      const delta = after.medianMs - before.medianMs;
      row.deltaPct = delta / before.medianMs;
      row.noiseMs = Math.max(rangeMs(before), rangeMs(after));
      row.busy = Math.max(peakLoad(scenario), peakLoad(previous.scenarios[name])) > config.highLoad;
      if (row.deltaPct > config.threshold && delta >= config.minDeltaMs) row.status = 'REGRESSION';
      else if (row.deltaPct < -config.threshold && -delta >= config.minDeltaMs) row.status = 'faster';
      if (row.status !== 'ok') {
        if (Math.abs(delta) <= row.noiseMs) row.status = 'within noise';
        else if (row.busy || Math.max(after.spread ?? 0, before.spread ?? 0) > config.noisySpread) {
          row.status += ' (noisy)';
        }
        if (Math.min(before.n - before.failures, after.n - after.failures) < config.confirmReps) {
          notes.push(`${name} ${row.status}: rerun both builds with --reps ${config.confirmReps} to confirm`);
        }
      }
    }
  }
  return { loadLatest, loadPrevious, rows, notes, refused };
}

/** Runs grouped by machine, oldest first. */
export function groupByMachine(runs) {
  const groups = new Map();
  for (const run of runs) {
    const id = run.machine?.id ?? 'unknown';
    groups.set(id, [...(groups.get(id) ?? []), run]);
  }
  for (const [id, list] of groups)
    groups.set(
      id,
      list.toSorted((a, b) => a.startedAt.localeCompare(b.startedAt)),
    );
  return groups;
}

const seconds = (ms) => (ms === null || ms === undefined ? '-' : `${(ms / 1000).toFixed(1)}s`);

const describeRun = (run) => `${run.stim?.label ?? run.stim?.version} ${run.startedAt.slice(0, 16)}Z`;

export function formatComparison(machine, latest, previous, result) {
  const header = ['scenario', 'previous', 'latest', 'delta', 'spread', 'failed', 'status'];
  const lines = result.rows.map((row) => [
    row.scenario,
    seconds(row.before?.medianMs),
    seconds(row.after.medianMs),
    row.deltaPct === null ? '-' : `${row.deltaPct >= 0 ? '+' : ''}${(row.deltaPct * 100).toFixed(1)}%`,
    row.after.spread === null ? '-' : `${Math.round(row.after.spread * 100)}%`,
    `${row.after.failures}/${row.after.n}`,
    row.status,
  ]);
  const widths = header.map((title, index) => Math.max(title.length, ...lines.map((line) => line[index].length)));
  const render = (line) => line.map((cell, index) => cell.padEnd(widths[index])).join('  ');
  return [
    `${machine}: ${describeRun(latest)} against ${describeRun(previous)}`,
    `load ${result.loadLatest?.toFixed(1) ?? '-'} against ${result.loadPrevious?.toFixed(1) ?? '-'}`,
    render(header),
    ...lines.map(render),
    ...result.notes.map((note) => `note: ${note}`),
  ].join('\n');
}

export function slug(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** A stable id for this machine that names no host: the model plus a short hash of the host name. */
export function machineId(model, hostname) {
  return `${slug(model || 'machine')}-${createHash('sha256').update(hostname).digest('hex').slice(0, 6)}`;
}

/** `text` with the home and temporary directories replaced and only its end kept, for the local log. */
export function scrubOutput(text, { home, tmp }, max = 300) {
  let out = String(text ?? '').trim();
  for (const [dir, label] of [
    [tmp, '<tmp>'],
    [home, '~'],
  ]) {
    if (dir) out = out.split(dir).join(label);
  }
  return out.length > max ? out.slice(-max) : out;
}
