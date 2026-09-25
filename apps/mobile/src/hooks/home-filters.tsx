import * as SecureStore from 'expo-secure-store';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { DEFAULT_FILTERS, parseFilters, type HomeFilters } from '@/lib/home';

const KEY = 'stim.homeFilters';

interface FiltersContext {
  filters: HomeFilters;
  update: (patch: Partial<HomeFilters>) => void;
  reset: () => void;
}

const Context = createContext<FiltersContext>({ filters: DEFAULT_FILTERS, update: () => {}, reset: () => {} });

/** The home screen filters, saved on this phone so they survive restarts. */
export function HomeFiltersProvider({ children }: { children: ReactNode }) {
  const [filters, setFilters] = useState<HomeFilters>(DEFAULT_FILTERS);

  useEffect(() => {
    SecureStore.getItemAsync(KEY).then(
      (raw) => setFilters(parseFilters(raw)),
      () => {},
    );
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
    }),
    [filters, save],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useHomeFilters(): FiltersContext {
  return useContext(Context);
}
