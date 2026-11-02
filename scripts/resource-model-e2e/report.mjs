import { STATUS } from './assertions.mjs';
import { PROCESS_KINDS } from './platform.mjs';
import { bucketRows, maxOf, minOf, pagesToMb } from './analysis.mjs';

const cell = (value) =>
  String(value ?? 'n/a')
    .replaceAll('|', '\\|')
    .replaceAll('\n', ' ');
const table = (head, rows) =>
  [
    `| ${head.join(' | ')} |`,
    `| ${head.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`),
  ].join('\n');
const gb = (mb) => (mb === null ? 'n/a' : `${(mb / 1024).toFixed(1)} GB`);
const mmss = (ms) =>
  `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;
const LABEL = { pass: 'PASS', fail: 'FAIL', unavailable: 'N/A' };
const BAR_WIDTH = 20;

const bar = (value, max) =>
  value === null || !max ? '' : '#'.repeat(Math.max(value > 0 ? 1 : 0, Math.round((value / max) * BAR_WIDTH)));

function summarize(assertions) {
  const count = (status) => assertions.filter((a) => a.status === status).length;
  return { pass: count(STATUS.pass), fail: count(STATUS.fail), unavailable: count(STATUS.unavailable) };
}

const rssAt = (row) => PROCESS_KINDS.reduce((sum, kind) => sum + (row[`rss_${kind}_mb`] ?? 0), 0);

function headline(meta, samples, assertions) {
  const counts = summarize(assertions);
  const pressureSamples = (level) => samples.filter((row) => (row.pressure ?? 0) >= level).length;
  const interval = samples.length > 1 ? (samples.at(-1).epoch - samples[0].epoch) / (samples.length - 1) : 5;
  const peakRss = samples.reduce((best, row) => Math.max(best, rssAt(row)), 0);
  return [
    ['Scenario', `${meta.scenario} on ${meta.targetLabel}`],
    [
      'Result',
      `${counts.fail ? 'FAIL' : 'PASS'}: ${counts.pass} passed, ${counts.fail} failed, ${counts.unavailable} not available on this build`,
    ],
    ['Machine', meta.machineLabel],
    ['Build under test', meta.stimLabel],
    [
      'Project',
      `${meta.projectLabel}, ${meta.workspaces} worktrees at ${meta.commit?.slice(0, 9) ?? 'n/a'}, fingerprint ${meta.fingerprint?.slice(0, 8) ?? 'n/a'}`,
    ],
    ['Clocks', meta.clockLabel],
    ['Duration', mmss(meta.durationMs)],
    ['Peak 1-minute load', maxOf(samples, 'load1')],
    [
      'Memory pressure',
      `peak level ${maxOf(samples, 'pressure') ?? 'n/a'}; ${Math.round(pressureSamples(2) * interval)} s at warning or worse, ${Math.round(pressureSamples(4) * interval)} s critical`,
    ],
    ['Peak swap used', gb(maxOf(samples, 'swap_used_mb'))],
    [
      'Lowest free memory pages',
      gb(pagesToMb(minOf(samples, 'vm_free_pages'), samples.find((row) => row.page_bytes)?.page_bytes ?? null)),
    ],
    [
      'Lowest free disk',
      `simulators ${gb(minOf(samples, 'disk_free_mb'))}, home ${gb(minOf(samples, 'home_free_mb'))}, worktrees ${gb(minOf(samples, 'work_free_mb'))}`,
    ],
    [
      'Most owned devices booted or booting',
      `${Math.max(0, ...samples.map((row) => (row.booted_ours ?? 0) + (row.booting_ours ?? 0)))} (derived cap ${meta.deviceCap ?? 'n/a'}); most booting at once ${maxOf(samples, 'booting_ours') ?? 'n/a'}`,
    ],
    [
      'Peak stim processes',
      ['supervisor', 'collector', 'daemon', 'metro', 'xcodebuild']
        .map((kind) => `${kind} ${maxOf(samples, `n_${kind}`) ?? 0}`)
        .join(', '),
    ],
    ['Peak stim process RSS', gb(peakRss)],
    ['Daemon', meta.daemonLabel ?? 'not available on this build'],
  ];
}

function samplerTable(samples, durationSec) {
  if (!samples.length) return 'No samples were recorded.';
  const width = Math.max(60, Math.ceil(durationSec / 120 / 60) * 60);
  const buckets = bucketRows(samples, width, {
    load1: 'max',
    pressure: 'max',
    swap_used_mb: 'max',
    vm_free_pages: 'min',
    disk_free_mb: 'min',
    home_free_mb: 'min',
    booted_ours: 'max',
    booting_ours: 'max',
    n_supervisor: 'max',
    n_collector: 'max',
    n_daemon: 'max',
    n_metro: 'max',
    n_xcodebuild: 'max',
  });
  const peakLoad = Math.max(...buckets.map((b) => b.load1 ?? 0));
  const pageBytes = samples.find((row) => row.page_bytes)?.page_bytes ?? null;
  return table(
    [
      'Time',
      'Stage',
      'Load max',
      'Load',
      'Pressure max',
      'Swap GB',
      'Free mem GB',
      'Free sim disk GB',
      'Free home disk GB',
      'Booted',
      'Booting',
      'Sup',
      'Col',
      'Dmn',
      'Metro',
      'xcodebuild',
    ],
    buckets.map((b) => [
      mmss(b.offsetSec * 1000),
      b.stage || '',
      b.load1,
      bar(b.load1, peakLoad),
      b.pressure,
      b.swap_used_mb === null ? null : (b.swap_used_mb / 1024).toFixed(1),
      pagesToMb(b.vm_free_pages, pageBytes) === null ? null : (pagesToMb(b.vm_free_pages, pageBytes) / 1024).toFixed(1),
      b.disk_free_mb === null ? null : (b.disk_free_mb / 1024).toFixed(1),
      b.home_free_mb === null ? null : (b.home_free_mb / 1024).toFixed(1),
      b.booted_ours,
      b.booting_ours,
      b.n_supervisor,
      b.n_collector,
      b.n_daemon,
      b.n_metro,
      b.n_xcodebuild,
    ]),
  );
}

export function renderReport({ meta, assertions, workspaces, events, samples, teardown, harnessError }) {
  const lines = [`# Resource model end-to-end run ${meta.runId}`, ''];
  if (harnessError) lines.push(`> The harness stopped early: ${harnessError}`, '');
  lines.push('## Headline', '', table(['Measure', 'Value'], headline(meta, samples, assertions)), '');

  lines.push('## Assertions', '');
  lines.push(
    table(
      ['Result', 'Scenario', 'Assertion'],
      assertions.map((a) => [LABEL[a.status], a.scenario, `${a.id}: ${a.title}`]),
    ),
    '',
  );
  for (const a of assertions) {
    lines.push(`### ${LABEL[a.status]} ${a.id}`, '', a.title, '', ...a.evidence.map((line) => `- ${line}`), '');
  }

  lines.push('## Per-workspace results', '');
  lines.push(
    table(
      ['Workspace', 'Role', 'stim ios exit', 'stim ios s', 'Cache', 'Launched', 'Error', 'Revive exit', 'Revive s'],
      workspaces.map(({ label, role, record }) => [
        label,
        role,
        record.iosExit,
        record.iosMs === undefined ? null : Math.round(record.iosMs / 1000),
        record.cacheHit,
        record.launched,
        record.errorCode,
        record.reviveExit,
        record.reviveMs === undefined ? null : Math.round(record.reviveMs / 1000),
      ]),
    ),
    '',
  );

  lines.push('## Timeline', '');
  lines.push(
    table(
      ['Time', 'Kind', 'Event'],
      events.map((event) => [mmss(event.t - meta.startedAt), event.kind, event.msg]),
    ),
    '',
  );

  lines.push(
    '## Sampler',
    '',
    `Samples every ${meta.sampleIntervalSec} s; each row folds the samples of one bucket (maximum, or minimum for free space). Process counts are the run's own.`,
    '',
  );
  lines.push(samplerTable(samples, meta.durationMs / 1000), '');

  lines.push('## Teardown', '');
  if (teardown) {
    lines.push(
      `- worktrees removed: ${teardown.worktrees.filter((w) => w.removed).length} of ${teardown.worktrees.length}`,
      `- simulators deleted from the run's ledger after worktree removal: ${teardown.simulators.length}${teardown.simulators.length ? ` (${teardown.simulators.map((s) => s.name).join(', ')})` : ''}`,
      `- trash empty: ${teardown.trashEmpty}`,
      `- processes that had to be signalled: ${teardown.processes.length}`,
      `- private home deleted: ${teardown.homeDeleted}`,
      ...teardown.errors.map((error) => `- error: ${error}`),
      '',
    );
  } else lines.push('Teardown did not run.', '');
  return lines.join('\n');
}
