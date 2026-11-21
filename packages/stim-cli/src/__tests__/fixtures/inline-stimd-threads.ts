import { processContext } from '../../cli-operation.ts';
import { measureDependencyTrees } from '../../daemon/dependencies.ts';
import { createMaintenanceLane, type MaintenanceLane } from '../../daemon/passes.ts';
import type { ThreadTable } from '../../stimd/threads.ts';
import { requestGcPass, requestGcItem } from '../../daemon/disk-owner.ts';
import { runGcPass } from '../../commands/gc.ts';
import { runGcItem } from '../../stimd/gc-item.ts';

type Log = Parameters<typeof createMaintenanceLane>[0];

/** stimd's thread table run on the test's own thread, so a test's spies and fake clocks reach the passes. */
export function createThreadTable(): ThreadTable {
  const controller = new AbortController();
  return {
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
    item: ({ item, cwd }, output) =>
      requestGcItem((signal) =>
        runGcItem(item, { ...processContext(cwd, AbortSignal.any([signal, controller.signal])), cwd, output }),
      ),
    gc: ({ level, client, walkUnknown, cwd }, onAction) =>
      requestGcPass(
        level,
        client,
        (asked, signal, emit, onLevel) =>
          runGcPass(
            { ...(asked ? { level: asked } : {}), client, ...(walkUnknown === false ? { walkUnknown } : {}) },
            { ...processContext(cwd, AbortSignal.any([signal, controller.signal])), cwd },
            emit,
            onLevel,
          ),
        onAction,
      ),
  };
}

export function createPassesLane(_threads: ThreadTable, log: Log): MaintenanceLane {
  return createMaintenanceLane(log);
}
