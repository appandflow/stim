import * as SecureStore from 'expo-secure-store';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { DEFAULT_FILTERS, parseFilters, type HomeFilters } from '@/lib/home';

const KEY = 'stim.homeFilters';
const VIEW_KEY = 'stim.homeView';

export type HomeView = 'workspaces' | 'devices' | 'machines';

interface FiltersContext {
  filters: HomeFilters;
  update: (patch: Partial<HomeFilters>) => void;
  reset: () => void;
  view: HomeView;
  setView: (view: HomeView) => void;
}

const Context = createContext<FiltersContext>({
  filters: DEFAULT_FILTERS,
  update: () => {},
  reset: () => {},
  view: 'workspaces',
  setView: () => {},
});

/** The home screen filters and view, saved on this phone so they survive restarts. */
export function HomeFiltersProvider({ children }: { children: ReactNode }) {
  const [filters, setFilters] = useState<HomeFilters>(DEFAULT_FILTERS);
  const [view, setViewState] = useState<HomeView>('workspaces');

  useEffect(() => {
    SecureStore.getItemAsync(KEY).then(
      (raw) => setFilters(parseFilters(raw)),
      () => {},
    );
    SecureStore.getItemAsync(VIEW_KEY).then(
      (raw) => setViewState(raw === 'devices' || raw === 'machines' ? raw : 'workspaces'),
      () => {},
    );
  }, []);

  const setView = useCallback((next: HomeView) => {
    setViewState(next);
    SecureStore.setItemAsync(VIEW_KEY, next).catch(() => {});
  }, []);

  const save = useCallback((next: HomeFilters) => {
    setFilters(next);
    SecureStore.setItemAsync(KEY, JSON.stringify(next)).catch(() => {});
  }, []);

  const value = useMemo(
    () => ({
      filters,
      update: (patch: Partial<HomeFilters>) => save({ ...filters, ...patch }),
      reset: () => save(DEFAULT_FILTERS),
      view,
      setView,
    }),
    [filters, save, view, setView],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useHomeFilters(): FiltersContext {
  return useContext(Context);
}
