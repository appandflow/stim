import { useIsFocused } from 'expo-router';
import { useEffect, useState } from 'react';
import { AppState } from 'react-native';

import type { LogFilter, LogRecord } from '@/protocol/types';

import { useMacConnection } from './machines';

export type LogsChange =
  | { kind: 'reset' }
  | { kind: 'records'; records: LogRecord[] }
  | { kind: 'error'; message: string };

export function useLogs(filter: LogFilter | null, onChange: (change: LogsChange) => void): boolean {
  const { connection } = useMacConnection();
  const focused = useIsFocused();
  const [foreground, setForeground] = useState(AppState.currentState === 'active');
  const active = focused && foreground;
  const key = filter ? JSON.stringify(filter) : null;
  useEffect(() => {
    const listener = AppState.addEventListener('change', (state) => setForeground(state === 'active'));
    return () => listener.remove();
  }, []);
  useEffect(() => {
    if (!connection || !key || !active) return;
    let stopped = false;
    onChange({ kind: 'reset' });
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
