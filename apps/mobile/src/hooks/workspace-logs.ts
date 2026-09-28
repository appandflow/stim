import { useCallback, useMemo, useState } from 'react';

import { useLogs, type LogsChange } from '@/hooks/mac-connection';
import { agentActions, agentFeedFilter, appendRecords, type AgentAction } from '@/lib/logs';
import type { LogFilter, LogRecord } from '@/protocol/types';

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

export function useBuildOutput(workspace: string, slot: string, since: string | null, max: number): LogRecord[] {
  const enabled = since !== null;
  const from = since === null ? NaN : Date.parse(since);
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
  return enabled ? records.filter((record) => !(record.ts < from)) : [];
}
