import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';

import type { StimConnection } from '@/lib/connection';
import { PlanChecks, type PlanSnapshot, type PlanState } from '@/lib/plan-checks';
import type { Platform } from '@/protocol/types';

import { useMacConnection } from './machines';

const planChecks = new WeakMap<StimConnection, PlanChecks>();
const NO_PLANS: PlanSnapshot = new Map();
const noSubscription = () => () => {};

/** Checks each workspace's platform predictions while it is mounted and has no running build. Builds nothing. */
export function useWorkspaceBuildPlans(
  requests: {
    workspace: string;
    builds: Partial<Record<Platform, string>>;
    building: boolean;
  }[],
): (workspace: string, platform: Platform) => PlanState | undefined {
  const { checks, snapshot } = usePlanChecks();
  const open = useMacConnection().state.kind === 'open';
  const wanted = JSON.stringify(requests);
  const paths = JSON.stringify(requests.map((request) => request.workspace));
  useEffect(() => {
    if (!checks) return;
    const workspaces = JSON.parse(wanted) as typeof requests;
    for (const { workspace, builds, building } of workspaces) {
      if (building) checks.cancel(workspace);
      else checks.check(workspace, builds);
    }
  }, [checks, wanted, open]);
  useEffect(() => {
    const workspaces = JSON.parse(paths) as string[];
    return () => {
      for (const workspace of workspaces) checks?.cancel(workspace);
    };
  }, [checks, paths]);
  return (workspace, platform) => PlanChecks.state(snapshot, workspace, platform);
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
