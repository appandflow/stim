import { useIsFocused } from 'expo-router';
import { useEffect } from 'react';

import { archiveError } from '@/lib/archived';

import type { LogFilter, LogRecord } from '@/protocol/types';

import { useAppForeground } from './app-foreground';
import { useMacConnection } from './machines';

export type LogsChange =
  | { kind: 'reset' }
  | { kind: 'records'; records: LogRecord[] }
  | { kind: 'error'; message: string };

export function useLogs(filter: LogFilter | null, onChange: (change: LogsChange) => void): boolean {
  const { connection, state } = useMacConnection();
  const open = state.kind === 'open';
  const focused = useIsFocused();
  const foreground = useAppForeground();
  const active = focused && foreground;
  const key = filter && (!filter.archive || open) ? JSON.stringify(filter) : null;
  useEffect(() => {
    if (!connection || !key || !active) return;
    let stopped = false;
    onChange({ kind: 'reset' });
    const params = JSON.parse(key) as LogFilter;
    if (params.archive) {
      connection.request('logs.query', params).then(
        ({ records }) => {
          if (!stopped) onChange({ kind: 'records', records });
        },
        (error: Error) => {
          if (!stopped) onChange({ kind: 'error', message: archiveError(error, 'logs') });
        },
      );
      return () => {
        stopped = true;
      };
    }
    const unsubscribe = connection.subscribe(
      'logs.subscribe',
      JSON.parse(key) as LogFilter,
      (event) => {
        if (stopped) return;
        if (event.event === 'logs') onChange({ kind: 'records', records: event.records });
        if (event.event === 'error') onChange({ kind: 'error', message: event.error.message });
      },
      () => {
        if (!stopped) onChange({ kind: 'reset' });
      },
    );
    return () => {
      stopped = true;
      unsubscribe();
    };
  }, [connection, key, onChange, active]);
  return active;
}
