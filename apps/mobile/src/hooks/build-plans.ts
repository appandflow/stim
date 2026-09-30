import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';

import type { StimConnection } from '@/lib/connection';
import { PlanChecks, type PlanSnapshot, type PlanState } from '@/lib/plan-checks';
import type { Platform } from '@/protocol/types';

import { useMacConnection } from './machines';

const planChecks = new WeakMap<StimConnection, PlanChecks>();
const NO_PLANS: PlanSnapshot = new Map();
const noSubscription = () => () => {};

/**
 * `build.plan` for each platform in `builds` (platform to `planKey` of its last build), checked while the
 * calling screen is mounted and no build runs. It builds nothing, so a read-only pairing may ask.
 */
export function useBuildPlans(
  workspace: string,
  builds: Partial<Record<Platform, string>>,
  building: boolean,
): (platform: Platform) => PlanState | undefined {
  const { checks, snapshot } = usePlanChecks();
  const open = useMacConnection().state.kind === 'open';
  const wanted = JSON.stringify(builds);
  useEffect(() => {
    if (!checks) return;
    if (building) checks.cancel(workspace);
    else checks.check(workspace, JSON.parse(wanted) as Partial<Record<Platform, string>>);
  }, [checks, workspace, wanted, building, open]);
  useEffect(() => () => checks?.cancel(workspace), [checks, workspace]);
  return (platform) => PlanChecks.state(snapshot, workspace, platform);
}

/**
 * The last `build.plan` result for `workspace` and `platform` and when it settled, without asking for one.
 * `recheck` asks again for the build `buildKey`, the `planKey` of the platform's last build.
 */
export function useBuildPlan(
  workspace: string,
  platform: Platform,
  buildKey: string,
  building: boolean,
): { plan: PlanState | undefined; checkedAt: number | null; recheck: (() => void) | null } {
  const { checks, snapshot } = usePlanChecks();
  const recheck = useCallback(
    () => checks?.check(workspace, { [platform]: buildKey }, true),
    [checks, workspace, platform, buildKey],
  );
  return {
    plan: PlanChecks.state(snapshot, workspace, platform),
    checkedAt: PlanChecks.checkedAt(snapshot, workspace, platform),
    recheck: checks && !building ? recheck : null,
  };
}

function usePlanChecks(): { checks: PlanChecks | null; snapshot: PlanSnapshot } {
  const { connection } = useMacConnection();
  const checks = useMemo(() => {
    if (!connection) return null;
    let found = planChecks.get(connection);
    if (!found) {
      found = new PlanChecks((path, platform) => connection.request('build.plan', { workspace: path, platform }));
      planChecks.set(connection, found);
    }
    return found;
  }, [connection]);
  const snapshot = useSyncExternalStore(checks?.subscribe ?? noSubscription, checks?.snapshot ?? (() => NO_PLANS));
  return { checks, snapshot };
}
