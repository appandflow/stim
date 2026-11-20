import { processContext } from '../../cli-operation.ts';
import { measureDependencyTrees } from '../../daemon/dependencies.ts';
import { createDormantGate } from '../../daemon/dormant-gate.ts';
import { createMaintenanceLane, type MaintenanceLane } from '../../daemon/passes.ts';
import type { ThreadTable } from '../../stimd/threads.ts';

type Log = Parameters<typeof createMaintenanceLane>[0];

/** stimd's thread table run on the test's own thread, so a test's spies and fake clocks reach the passes. */
export function createThreadTable(): ThreadTable {
  const controller = new AbortController();
  return {
    dormant: { cadence: new BigInt64Array(1), gate: createDormantGate() },
    async run() {
      await measureDependencyTrees(processContext(process.cwd(), controller.signal)).catch((error: unknown) => {
        throw controller.signal.aborted && !(error instanceof Error && 'reportCleanup' in error)
          ? new Error('aborted')
          : error;
      });
      return [];
    },
    abort() {
      controller.abort();
    },
    settle() {},
    async close() {},
  };
}

export function createPassesLane(threads: ThreadTable, log: Log): MaintenanceLane {
  return createMaintenanceLane(log, undefined, threads.dormant?.cadence, threads.dormant?.gate);
}
