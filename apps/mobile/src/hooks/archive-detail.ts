import { useIsFocused } from 'expo-router';

import { useAppForeground } from '@/hooks/app-foreground';
import { useMacConnection } from '@/hooks/machines';
import { usePolledRequest } from '@/hooks/polled-request';

export function useArchiveDetail(archive: string) {
  const { connection, state } = useMacConnection();
  const focused = useIsFocused();
  const foreground = useAppForeground();
  return usePolledRequest(
    connection,
    'archive.detail',
    { archive },
    {
      active: focused && foreground && state.kind === 'open',
    },
  );
}
