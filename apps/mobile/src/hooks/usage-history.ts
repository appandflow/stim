import { useEffect, useRef, useState } from 'react';

import { usePolledRequest } from '@/hooks/polled-request';
import type { StimConnection } from '@/lib/connection';
import { mergeUsageSamples } from '@/lib/home';
import type { MachineUsage, UsageSample } from '@/protocol/types';

export function useUsageHistory(connection: StimConnection | null, open: boolean, usage: MachineUsage | null) {
  const [samples, setSamples] = useState<UsageSample[] | null>(null);
  const lastAt = useRef<number | undefined>(undefined);
  const loaded = samples !== null;

  usePolledRequest(
    connection,
    'machine.history',
    {},
    {
      active: open,
      onData: (history) => setSamples(mergeUsageSamples([], history.samples)),
      onError: () => setSamples(null),
    },
  );

  useEffect(() => {
    lastAt.current = samples?.at(-1)?.at;
  }, [samples]);

  useEffect(() => {
    if (!connection || !open || !usage || !loaded) return;
    let cancelled = false;
    const sinceMs = lastAt.current;
    connection.request('machine.history', sinceMs === undefined ? {} : { sinceMs }).then(
      (history) => !cancelled && setSamples((current) => mergeUsageSamples(current ?? [], history.samples)),
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [connection, open, usage, loaded]);

  return samples;
}
