import { useCallback, useEffect, useState } from 'react';

import { welcomeState } from '@/lib/welcome';
import { prefsStorage } from '@/storage';

const SEEN_KEY = 'welcome.seen';

export function useWelcome(macs: readonly unknown[] | null | undefined) {
  const [seen, setSeen] = useState(() => prefsStorage.getBoolean(SEEN_KEY) ?? false);
  const { show, markSeen } = welcomeState(macs, seen);

  useEffect(() => {
    if (markSeen) prefsStorage.set(SEEN_KEY, true);
  }, [markSeen]);

  const dismiss = useCallback(() => {
    prefsStorage.set(SEEN_KEY, true);
    setSeen(true);
  }, []);

  return { show, dismiss };
}
