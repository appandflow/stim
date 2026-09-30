import { useEffect } from 'react';

import type { LogFilter, LogRecord } from '@/protocol/types';

import { useMacConnection } from './machines';

export type LogsChange =
  | { kind: 'reset' }
  | { kind: 'records'; records: LogRecord[] }
  | { kind: 'error'; message: string };

export function useLogs(filter: LogFilter | null, onChange: (change: LogsChange) => void): void {
  const { connection } = useMacConnection();
  const key = filter ? JSON.stringify(filter) : null;
  useEffect(() => {
    if (!connection || !key) return;
    onChange({ kind: 'reset' });
    return connection.subscribe(
      'logs.subscribe',
      JSON.parse(key) as LogFilter,
      (event) => {
        if (event.event === 'logs') onChange({ kind: 'records', records: event.records });
        if (event.event === 'error') onChange({ kind: 'error', message: event.error.message });
      },
      () => onChange({ kind: 'reset' }),
    );
  }, [connection, key, onChange]);
}
