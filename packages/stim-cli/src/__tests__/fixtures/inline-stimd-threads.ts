import { processContext } from '../../cli-operation.ts';
import { measureDependencyTrees } from '../../daemon/dependencies.ts';
import { createMaintenanceLane, runDiskPass, runLadderToFree, type MaintenanceLane } from '../../daemon/passes.ts';
import type { ThreadTable } from '../../stimd/threads.ts';
import { LADDER, requestGcPass, requestGcItem } from '../../daemon/disk-owner.ts';
import { runGcPass, sweepGcReport } from '../../commands/gc.ts';
import { runGcItem } from '../../stimd/gc-item.ts';
import { dirtyGcMarks } from '../../fsevents-state.ts';
import { refreshKnownMarks } from '../../daemon/mark-refresh.ts';
import { readMarkHealth } from '../../daemon/mark-health.ts';

type Log = Parameters<typeof createMaintenanceLane>[0];

/** stimd's thread table run on the test's own thread, so a test's spies and fake clocks reach the passes. */
export function createThreadTable(log: Log = () => {}): ThreadTable {
  const controller = new AbortController();
  return {
    ladder: (input) => runDiskPass(input, log, processContext(process.cwd(), controller.signal)),
    marks(input) {
      const stop = new AbortController();
      return {
        result: refreshKnownMarks(
          input,
          processContext(process.cwd(), AbortSignal.any([stop.signal, controller.signal])),
        ).then(() => ({ marks: true as const })),
        leave: () => stop.abort(),
      };
    },
    drainTrash: async () => {},
    report() {
      const stop = new AbortController();
      return {
        result: sweepGcReport(processContext(process.cwd(), AbortSignal.any([stop.signal, controller.signal]))),
        leave: () => stop.abort(),
      };
    },
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
    async dirty(roots, at) {
      dirtyGcMarks(roots, at);
    },
    async history(config, mode) {
      return readMarkHealth(config, processContext(process.cwd(), controller.signal), mode);
    },
    headroom: ({ headroom, cwd, act }) => {
      const asked = requestGcItem(async (signal) => {
        await runLadderToFree({ ...headroom, operation: processContext(cwd, controller.signal), signal, act });
        return { headroom: true as const };
      }, LADDER);
      const timer = setTimeout(asked.leave, Math.max(0, headroom.deadline - Date.now()));
      return { result: asked.result.finally(() => clearTimeout(timer)), leave: asked.leave };
    },
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
