import { useCallback, useState } from 'react';

import { usePolledRequest } from '@/hooks/polled-request';
import type { StimConnection } from '@/lib/connection';

export interface RecordingSetting {
  /** Null until the Mac answers, and from a Mac whose stim has no such setting. */
  enabled: boolean | null;
  /** STIM_RECORDING in the Mac's environment decides, so the setting cannot change it. */
  fromEnvironment: boolean;
  saving: boolean;
  error: string | null;
  set: (enabled: boolean) => void;
}

/** A paired Mac's machine-wide `recording.enabled`, read with `settings.get` and changed with `recording.set`. */
export function useRecordingSetting(connection: StimConnection | null): RecordingSetting {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [fromEnvironment, setFromEnvironment] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  usePolledRequest(
    connection,
    'settings.get',
    {},
    {
      active: true,
      onData: (payload) => {
        const settings = Array.isArray(payload.settings) ? payload.settings : [];
        const entry = settings.find(
          (candidate): candidate is { value: unknown; origin: unknown } =>
            typeof candidate === 'object' && candidate !== null && candidate.key === 'recording.enabled',
        );
        setEnabled(typeof entry?.value === 'boolean' ? entry.value : null);
        setFromEnvironment(entry?.origin === 'env');
      },
    },
  );
  const set = useCallback(
    (next: boolean) => {
      if (!connection) return;
      setSaving(true);
      setError(null);
      setEnabled(next);
      connection.request('recording.set', { enabled: next }).then(
        (result) => {
          setEnabled(result.enabled);
          setSaving(false);
        },
        (cause: Error) => {
          setEnabled(!next);
          setSaving(false);
          setError(cause.message);
        },
      );
    },
    [connection],
  );
  return { enabled, fromEnvironment, saving, error, set };
}
