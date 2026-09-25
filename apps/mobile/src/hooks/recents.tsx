import * as SecureStore from 'expo-secure-store';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { useMacs } from '@/hooks/mac-connection';
import { newlyLive, parseRecents, touchRecents, type RecentWorkspace } from '@/lib/recents';

const KEY = 'stim.recentWorkspaces';

interface RecentsContext {
  recents: RecentWorkspace[];
  touch: (workspace: RecentWorkspace) => void;
}

const Context = createContext<RecentsContext>({ recents: [], touch: () => {} });

/** The workspaces most recently live or opened, saved on this phone. */
export function RecentsProvider({ children }: { children: ReactNode }) {
  const { connections } = useMacs();
  const [recents, setRecents] = useState<RecentWorkspace[]>([]);
  const [loaded, setLoaded] = useState(false);
  const live = useRef<Set<string>>(new Set());

  useEffect(() => {
    SecureStore.getItemAsync(KEY)
      .then(
        (raw) => setRecents((touched) => touchRecents(parseRecents(raw), touched)),
        () => {},
      )
      .finally(() => setLoaded(true));
  }, []);

  useEffect(() => {
    if (loaded) SecureStore.setItemAsync(KEY, JSON.stringify(recents)).catch(() => {});
  }, [loaded, recents]);

  const touchAll = useCallback((workspaces: RecentWorkspace[]) => {
    setRecents((current) => touchRecents(current, workspaces));
  }, []);

  useEffect(() => {
    const next = newlyLive(
      live.current,
      connections.map((c) => ({ id: c.mac.id, name: c.mac.name, status: c.status })),
    );
    live.current = next.live;
    if (next.started.length > 0) touchAll(next.started);
  }, [connections, touchAll]);

  const touch = useCallback((workspace: RecentWorkspace) => touchAll([workspace]), [touchAll]);
  const value = useMemo(() => ({ recents, touch }), [recents, touch]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useRecents(): RecentsContext {
  return useContext(Context);
}
