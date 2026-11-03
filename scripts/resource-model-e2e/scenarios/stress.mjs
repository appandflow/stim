import { readFileSync } from 'node:fs';
import { derivedDeviceCap, longestStreak, maxOf, sampleQuality } from '../analysis.mjs';
import { clock, outcome, STATUS } from '../assertions.mjs';
import {
  assertIdleDown,
  launch,
  loadGate,
  pollStatus,
  reviveWorkspaces,
  setup,
  startPoller,
  waitForIdle,
} from '../phases.mjs';
import { parseCsv } from '../platform.mjs';

const SCENARIO = 'stress';
const CRITICAL_LEVEL = 4;
const CRITICAL_ALLOWED_MS = 60_000;
const MAX_BOOTS_IN_FLIGHT = 2;

function refusalCode(result) {
  if (result.ok) return null;
  const code = result.json?.code;
  if (typeof code === 'string' && code.startsWith('STIM_')) return code;
  return /\bSTIM_[A-Z0-9_]+\b/.exec(`${result.stderr}\n${result.stdout}`)?.[0] ?? null;
}

const verdict = (A, ok, ...args) => (ok ? A.pass(...args) : A.fail(...args));

function failureLine(result) {
  if (result.ok) return '';
  const message = result.json?.message ?? result.stderr.trim().split('\n').at(-1) ?? '';
  return `, ${result.json?.code ?? 'no failure payload'}: ${message.slice(0, 160)}`;
}

export function batchAssertions(ctx, { startedAt, runs }, rows) {
  const A = ctx.assertions;
  const window = rows.filter((row) => row.epoch * 1000 >= startedAt - 5000);
  const interval = ctx.sampleIntervalSec;
  const { gaps } = sampleQuality(window, interval);
  const gapNote = gaps.length
    ? `; ${gaps.length} sampler gaps in the window, longest ${Math.max(...gaps.map((g) => g.sec))} s`
    : '';
  const numeric = (column) => window.filter((row) => typeof row[column] === 'number');
  const missing = (column) => `${window.length - numeric(column).length} of ${window.length} rows had no ${column}`;
  const sampled = (usable, ok, id, title, evidence) =>
    usable.length
      ? verdict(A, ok, SCENARIO, id, title, evidence)
      : A.unavailable(SCENARIO, id, title, ['the sampler recorded no usable values for this check', ...evidence]);

  A.fromItems(
    SCENARIO,
    'exit-zero',
    'every concurrent `stim ios` exits 0',
    runs.map(({ workspace, result }) =>
      outcome(
        workspace.label,
        result.ok ? STATUS.pass : STATUS.fail,
        `exit ${result.code} after ${Math.round(result.ms / 1000)} s${failureLine(result)}`,
      ),
    ),
  );

  const cap = ctx.deviceCap;
  const both = window.filter((row) => typeof row.booted_ours === 'number' && typeof row.booting_ours === 'number');
  const peak = Math.max(0, ...both.map((row) => row.booted_ours + row.booting_ours));
  const reported = ctx.snapshots.map((poll) => poll.deviceSlots?.max).find((max) => max !== undefined);
  sampled(both, peak <= cap, 'booted-cap', `owned booted or booting devices never exceed the derived cap of ${cap}`, [
    `peak ${peak} over ${both.length} samples of ${interval} s (${window.length - both.length} of ${window.length} rows had no simulator reading${gapNote})`,
    `status capacity.devices.max: ${reported ?? 'not available on this build'}`,
  ]);

  const exposed = ctx.snapshots.filter((poll) => poll.bootsInFlight !== null);
  const title = `boots in flight never exceed ${MAX_BOOTS_IN_FLIGHT} (status capacity.devices holders)`;
  if (exposed.length) {
    const most = Math.max(...exposed.map((poll) => poll.bootsInFlight));
    verdict(A, most <= MAX_BOOTS_IN_FLIGHT, SCENARIO, 'boots-in-flight', title, [
      `peak ${most} over ${exposed.length} status polls`,
    ]);
  } else {
    A.unavailable(SCENARIO, 'boots-in-flight', title, [
      'not available on this build: status lists boot holders only while a device cap is set',
    ]);
  }
  const refusals = runs.map(({ workspace, result }) => ({ workspace, code: refusalCode(result) }));
  const byCode = Object.entries(
    Object.groupBy(
      refusals.filter((r) => r.code),
      (r) => r.code,
    ),
  ).map(([code, list]) => `${code} x${list.length}`);
  A.fromItems(SCENARIO, 'no-refusals', 'no run is refused (a non-zero exit with a STIM_ code)', [
    outcome(
      'summary',
      byCode.length ? STATUS.fail : STATUS.pass,
      byCode.length ? `refusals by code: ${byCode.join(', ')}` : 'no refusals',
    ),
    ...refusals.map(({ workspace, code }) =>
      outcome(workspace.label, code ? STATUS.fail : STATUS.pass, code ? `refused with ${code}` : 'not refused'),
    ),
  ]);

  const critical = longestStreak(numeric('pressure'), (row) => row.pressure === CRITICAL_LEVEL, interval);
  sampled(
    numeric('pressure'),
    critical.ms <= CRITICAL_ALLOWED_MS,
    'pressure-critical',
    'memory pressure is never critical for more than one 60 s tick',
    [
      `longest critical run ${Math.round(critical.ms / 1000)} s (${critical.samples} samples${critical.startEpoch ? ` from ${clock(critical.startEpoch * 1000)}` : ''}), peak level ${maxOf(window, 'pressure') ?? 'n/a'} (${missing('pressure')}${gapNote})`,
    ],
  );

  const empty = ['booted_ours', 'pressure'].filter((column) => numeric(column).length === 0);
  const dataTitle = 'the sampler recorded the columns the stress assertions read';
  if (empty.length)
    A.fail(SCENARIO, 'sampler-data', dataTitle, [`no usable value in ${empty.join(', ')} for the batch`]);
  else
    A.pass(SCENARIO, 'sampler-data', dataTitle, [
      `${window.length} rows in the batch window, every required column has data`,
    ]);

  ctx.emit(
    'stress',
    `most runs waiting at once (status build.waitingFor): ${Math.max(0, ...ctx.snapshots.map((poll) => poll.waitingRuns))}`,
  );
}

export async function runStress(ctx) {
  await setup(ctx, ctx.opts.workspaces);
  for (const workspace of ctx.workspaces) workspace.role = 'workspace';
  ctx.deviceCap = derivedDeviceCap(ctx.machine.ramBytes);
  const poller = startPoller(ctx);
  try {
    const seed = ctx.workspaces[0];
    await loadGate(ctx, 'the seed build');
    const seeded = await launch(ctx, seed);
    ctx.assertions.fromItems(
      SCENARIO,
      'seed',
      'the seed build in the first worktree launches and fills the build cache',
      [
        outcome(
          seed.label,
          seeded.ok ? STATUS.pass : STATUS.fail,
          `ios exit ${seeded.ios.code}, cache ${ctx.record(seed).cacheHit}`,
        ),
      ],
    );
    if (!seeded.ok) return;
    await ctx.stim.exec(`stop-${seed.label}`, seed.path, ['stop', '--json'], { timeoutMs: 5 * 60_000 });

    await loadGate(ctx, `the ${ctx.workspaces.length} concurrent runs`);
    ctx.setStage('batch');
    const startedAt = Date.now();
    ctx.emit('stress', `starting ${ctx.workspaces.length} stim ios at once`);
    const timeoutMs = Math.max(30, ctx.workspaces.length * 3) * 60_000;
    const runs = await Promise.all(
      ctx.workspaces.map(async (workspace) => ({
        workspace,
        result: await ctx.stim.exec(`ios-batch-${workspace.label}`, workspace.path, ['ios', '--json'], { timeoutMs }),
      })),
    );
    for (const { workspace, result } of runs) {
      Object.assign(ctx.record(workspace), {
        iosExit: result.code,
        iosMs: result.ms,
        launchedAt: result.endedAt,
        cacheHit: result.json?.cacheHit ?? null,
        launched: result.json?.launched ?? null,
        errorCode: result.ok ? null : (result.json?.code ?? 'no JSON failure payload'),
      });
    }
    ctx.emit(
      'stress',
      `batch finished in ${Math.round((Date.now() - startedAt) / 1000)} s; ${runs.filter(({ result }) => result.ok).length} of ${runs.length} exited 0`,
    );
    await pollStatus(ctx);

    const survivors = runs
      .filter(({ result }) => result.ok)
      .map(({ workspace, result }) => ({ workspace, commandEndMs: result.endedAt }));
    const waited = survivors.length
      ? await waitForIdle(ctx, survivors, { windowMs: ctx.idleWindowMs, graceMs: 5 * 60_000 })
      : new Map();
    if (survivors.length) await assertIdleDown(ctx, SCENARIO, waited, ctx.idleWindowMs);

    const idle = [...waited.values()].filter((entry) => entry.resolved).map((entry) => entry.workspace);
    const chosen = [...new Set([idle[0], idle[Math.floor(idle.length / 2)], idle.at(-1)].filter(Boolean))];
    if (chosen.length) await reviveWorkspaces(ctx, SCENARIO, chosen, { concurrent: true });
    else
      ctx.assertions.fail(SCENARIO, 'revive', 'three chosen workspaces revive', [
        'no workspace reached the idle stage, so none could be revived',
      ]);

    ctx.setStage('analysis');
    batchAssertions(ctx, { startedAt, runs }, parseCsv(readFileSync(`${ctx.out}/samples.csv`, 'utf8')));
  } finally {
    await poller.stop();
  }
}
