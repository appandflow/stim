import { createDebugLog, runId, type DebugLog } from '@stim-cli/core/state';

export const debugLog: DebugLog = createDebugLog('cli', { base: () => ({ runId: runId() }) });
