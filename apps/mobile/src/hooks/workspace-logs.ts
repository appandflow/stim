import { useCallback, useMemo, useState } from 'react';

import { useLogs, type LogsChange } from '@/hooks/mac-connection';
import { agentActions, agentFeedFilter, appendRecords, type AgentAction } from '@/lib/logs';
import type { LogFilter, LogRecord } from '@/protocol/types';

/** A device's latest agent actions from `logs.subscribe`, newest first, at most `max`. */
export function useAgentActions(workspace: string, slot: string, deviceId: string | null, max: number): AgentAction[] {
  const [actions, setActions] = useState<AgentAction[]>([]);
  const filter = useMemo(() => (deviceId ? agentFeedFilter(workspace, slot) : null), [workspace, slot, deviceId]);
  const onChange = useCallback(
    (change: LogsChange) => {
      if (change.kind === 'reset') setActions([]);
      if (change.kind === 'records' && deviceId) {
        setActions((existing) => agentActions(existing, change.records, deviceId, max));
      }
    },
    [deviceId, max],
  );
  useLogs(filter, onChange);
  return actions;
}

/** The last `max` build output lines of a slot while `enabled`, oldest first. */
export function useBuildOutput(workspace: string, slot: string, enabled: boolean, max: number): LogRecord[] {
  const [records, setRecords] = useState<LogRecord[]>([]);
  const filter = useMemo<LogFilter | null>(
    () => (enabled ? { workspace, sources: ['build'], slot, tail: max } : null),
    [workspace, slot, enabled, max],
  );
  const onChange = useCallback(
    (change: LogsChange) => {
      if (change.kind === 'reset') setRecords([]);
      if (change.kind === 'records') setRecords((existing) => appendRecords(existing, change.records, max));
    },
    [max],
  );
  useLogs(filter, onChange);
  return enabled ? records : [];
}
