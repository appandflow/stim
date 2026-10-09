import type { PlacementSkip } from './device-host/placement.ts';
import { buildPlacementSettings } from './offload/selection.ts';

export type SettingSource = 'flag' | 'env' | 'setting' | 'default';

export interface PlacementSetting {
  key: string;
  value: string;
  from: SettingSource;
}

export interface PlacementCandidate {
  machine: string;
  code: string;
  msg: string;
  /** Finer codes behind `code`, such as the toolchain parts of a version mismatch. */
  detail?: string[];
}

export interface PlacementRecord {
  src: 'placement';
  level: 'info' | 'warn';
  event: 'build_placement' | 'device_placement' | 'placement_fallback';
  msg: string;
  kind: 'build' | 'device';
  platform: 'ios' | 'android' | 'macos';
  settings: PlacementSetting[];
  candidates: PlacementCandidate[];
  choice: { machine: string; code: string; msg: string };
  fallback?: { code: string; msg: string; machine?: string };
}

/** `machine` is `local` when the run stays on this Mac. */
function placementRecord(
  input: Omit<PlacementRecord, 'src' | 'level' | 'msg' | 'event'> & { event?: PlacementRecord['event'] },
): PlacementRecord {
  const { choice, fallback } = input;
  const event = input.event ?? (input.kind === 'build' ? 'build_placement' : 'device_placement');
  const base = `${input.kind} placement: ${choice.machine} (${choice.msg})`;
  return {
    src: 'placement',
    level: fallback ? 'warn' : 'info',
    ...input,
    event,
    msg: fallback ? `${base}; fell back: ${fallback.msg}` : base,
  };
}

function skippedCandidates(skipped: PlacementSkip[]): PlacementCandidate[] {
  return skipped.map(({ machine, code, reason }) => ({ machine, code, msg: reason }));
}

export function devicePlacementRecord({
  platform,
  fromFlag,
  easFallback = false,
  placed,
}: {
  platform: 'ios' | 'android';
  fromFlag: boolean;
  easFallback?: boolean;
  placed: { placement: { machine?: string; reason: string }; code: string; skipped: PlacementSkip[] };
}): PlacementRecord {
  return placementRecord({
    kind: 'device',
    platform,
    settings: [
      { key: `${platform}.remote`, value: 'auto', from: fromFlag ? 'flag' : 'setting' },
      ...(easFallback ? [{ key: 'remote.easFallback', value: 'true', from: 'setting' as const }] : []),
    ],
    candidates: skippedCandidates(placed.skipped),
    choice: { machine: placed.placement.machine ?? 'local', code: placed.code, msg: placed.placement.reason },
  });
}

/**
 * The record for where a build runs. `stays` is the reason this Mac builds it, `chose` the remote Mac that takes it,
 * and `fallback` why a remote Mac that was meant to build it did not.
 */
export function buildPlacementRecord({
  platform,
  buildMachine,
  candidates = [],
  ...outcome
}: {
  platform: 'ios' | 'android' | 'macos';
  buildMachine: string;
  candidates?: PlacementCandidate[];
} & (
  | { stays: { code: string; reason: string } }
  | { chose: { machine: string; reason: string } }
  | { fallback: { code: string; reason: string; machine?: string }; event?: 'placement_fallback' }
)): PlacementRecord {
  const base = { kind: 'build' as const, platform, settings: buildPlacementSettings(buildMachine), candidates };
  if ('stays' in outcome)
    return placementRecord({
      ...base,
      choice: { machine: 'local', code: outcome.stays.code, msg: outcome.stays.reason },
    });
  if ('chose' in outcome)
    return placementRecord({
      ...base,
      choice: { machine: outcome.chose.machine, code: 'placed', msg: outcome.chose.reason },
    });
  const { code, reason, machine } = outcome.fallback;
  return placementRecord({
    ...base,
    event: outcome.event ?? 'build_placement',
    choice: { machine: 'local', code, msg: 'building on this Mac' },
    fallback: { code, msg: reason, ...(machine ? { machine } : {}) },
  });
}
