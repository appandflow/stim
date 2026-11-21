import { withAmbientContext, type StimContext } from '@stim-cli/core';
import { deleteGcItem, type GcItem, type GcItemResult } from '../commands/gc/item.ts';
import { runReport, trackReportResource } from '../report-runtime.ts';
import { WorkspaceProcessCleanupError } from '../engine/workspace-process-error.ts';

export function runGcItem(item: GcItem, operation: StimContext): Promise<GcItemResult> {
  return runReport(operation, (bounded) =>
    withAmbientContext(bounded, () => {
      const task = deleteGcItem(item, bounded);
      trackReportResource(
        bounded,
        task.then(
          () => undefined,
          (cause: unknown) => {
            if (cause instanceof WorkspaceProcessCleanupError || (cause instanceof Error && 'reportCleanup' in cause))
              throw cause;
          },
        ),
        () => {},
      );
      return task;
    }),
  );
}
