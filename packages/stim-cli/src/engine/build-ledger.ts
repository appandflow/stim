import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { withDirLock, workspaceName } from '@stim-cli/core';
import {
  BUILD_LEDGER_CAP,
  buildLedgerFile,
  buildLedgerLock,
  type BuildLedgerOutcome,
  type BuildLedgerRecord,
} from '@stim-cli/core/state';
import { formatElapsed } from '../command-output.ts';
import { STIM_VERSION } from '../stim-version.ts';
import { gitQuiet } from '../workspace/git.ts';

/** What a build knows about itself beyond the `lastBuild` record: carried under `lastBuild.ledger` and stripped from it. */
export interface BuildLedgerExtras {
  scheme?: string | null;
  message?: string | null;
  remedy?: string | null;
  /** The device's display name and runtime; never its serial or UDID. */
  device?: { name: string; runtime?: string | null } | null;
}

const LOCK_WAIT_MS = 2_000;
const GIT_TIMEOUT_MS = 2_000;

export interface BuildLedgerRun {
  id: string;
  now: number;
  root: string;
  workspace: string;
  branch: string | null;
  version: string;
  outcome: BuildLedgerOutcome;
  /** The finished `lastBuild` record. */
  record: Record<string, unknown>;
  extras: BuildLedgerExtras;
  phases: Record<string, number>;
  /** The phase the run was in when it finished. */
  phase: string | null;
  offload?: { host: string; phaseMs: Record<string, number> };
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function wholeMs(value: unknown): number {
  const ms = Number(value);
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms) : 0;
}

function wholePhaseMs(phases: Record<string, number> | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, ms] of Object.entries(phases ?? {})) if (wholeMs(ms) > 0) out[name] = wholeMs(ms);
  return out;
}

/** The remedy a thrown error carries, when it carries one. */
export function errorRemedy(error: unknown): string | undefined {
  const remedy = typeof error === 'object' && error !== null && 'remedy' in error ? error.remedy : undefined;
  return typeof remedy === 'string' && remedy !== '' ? remedy : undefined;
}

export function buildLedgerRecord(run: BuildLedgerRun): BuildLedgerRecord {
  const { record, extras, outcome } = run;
  const platform = record.platform === 'ios' || record.platform === 'android' ? record.platform : 'macos';
  const configuration = text(record.configuration);
  const durationMs = wholeMs(record.durationMs);
  const startedAt = Date.parse(String(record.startedAt));

  const fallback = text(record.offloadFallback);
  const machine = text(record.offloadedTo) ?? (fallback ? null : run.offload?.host) ?? null;
  const placement: BuildLedgerRecord['placement'] = machine
    ? { where: 'offloaded', machine }
    : fallback
      ? { where: 'local', fellBack: true, reason: fallback }
      : { where: 'local' };

  const hit = record.cacheHit === 'local' || record.cacheHit === 'remote' ? record.cacheHit : null;
  const missReason = text(record.missReason);
  const cache: BuildLedgerRecord['cache'] = {
    result: record.cacheSkipped === true ? 'bypassed' : hit ? 'hit' : 'miss',
    ...(hit && record.cacheSkipped !== true ? { source: hit } : {}),
    key: text(record.cacheKey),
    fingerprint: text(record.fingerprint),
    ...(missReason && !hit ? { missReason } : {}),
  };

  const offloadPhases = wholePhaseMs(run.offload?.phaseMs);
  const scheme = text(extras.scheme);
  const device = text(extras.device?.name);
  const runtime = text(extras.device?.runtime);
  const failure: BuildLedgerRecord['failure'] | undefined =
    outcome === 'succeeded'
      ? undefined
      : {
          code: text(record.errorCode),
          message: text(extras.message),
          remedy: text(extras.remedy),
          phase: run.phase,
        };

  const where = placement.machine ? `on ${placement.machine}` : 'here';
  const cacheText = cache.result === 'hit' ? `cache hit${cache.source === 'remote' ? ' (remote)' : ''}` : cache.result;
  const summary = `${platform} build ${outcome} ${where} in ${formatElapsed(durationMs)} (${cacheText})`;
  const why = failure ? `: ${[failure.code, failure.message].filter(Boolean).join(': ') || 'no reason recorded'}` : '';

  return {
    ts: run.now,
    src: 'builds',
    level: outcome === 'succeeded' ? 'info' : outcome === 'cancelled' ? 'warn' : 'error',
    msg: `${summary}${why}`,
    event: 'build',
    id: run.id,
    startedAt: Number.isFinite(startedAt) ? startedAt : run.now - durationMs,
    project: run.root,
    workspace: run.workspace,
    branch: run.branch,
    platform,
    ...(scheme ? { scheme } : {}),
    ...(platform === 'android' && configuration ? { variant: configuration } : {}),
    configuration,
    placement,
    cache,
    durationMs,
    phases: wholePhaseMs(run.phases),
    ...(Object.keys(offloadPhases).length ? { offloadPhases } : {}),
    outcome,
    ...(failure ? { failure } : {}),
    ...(device ? { device: { name: device, ...(runtime ? { runtime } : {}) } } : {}),
    stimVersion: run.version,
  };
}

function lineId(line: string): unknown {
  try {
    return (JSON.parse(line) as { id?: unknown }).id;
  } catch {
    return undefined;
  }
}

/**
 * The ledger file's text after appending `line`, keeping only the newest `cap` complete records. A run that records
 * twice (an Android launch that fails after the build was recorded) replaces its earlier record.
 */
export function appendCapped(existing: string, line: string, cap: number = BUILD_LEDGER_CAP): string {
  const id = lineId(line);
  const lines = existing.split('\n').filter((each) => each.trim() !== '' && (id === undefined || lineId(each) !== id));
  lines.push(line);
  return `${lines.slice(-cap).join('\n')}\n`;
}

export function appendBuildLedger(record: BuildLedgerRecord, file: string = buildLedgerFile()): void {
  withDirLock(
    buildLedgerLock(),
    () => {
      let existing = '';
      try {
        existing = readFileSync(file, 'utf-8');
      } catch {}
      const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      writeFileSync(tmp, appendCapped(existing, JSON.stringify(record)));
      try {
        renameSync(tmp, file);
      } catch (error) {
        rmSync(tmp, { force: true });
        throw error;
      }
    },
    {
      waitMs: LOCK_WAIT_MS,
      ensureParent: () => {
        mkdirSync(dirname(file), { recursive: true });
        mkdirSync(dirname(buildLedgerLock()), { recursive: true });
      },
    },
  );
}

/** Records one finished build in the ledger. A failure to do so never changes the run, so it is ignored. */
export function writeBuildLedger(
  root: string,
  run: Omit<BuildLedgerRun, 'id' | 'root' | 'workspace' | 'branch' | 'version'> & { id?: string },
): void {
  try {
    const branch =
      gitQuiet(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
        timeoutMs: GIT_TIMEOUT_MS,
      })?.trim() || null;
    appendBuildLedger(
      buildLedgerRecord({
        ...run,
        id: run.id ?? randomUUID(),
        root,
        workspace: workspaceName(root),
        branch,
        version: STIM_VERSION,
      }),
    );
  } catch {}
}
