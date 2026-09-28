import { useCallback, useState } from 'react';

import { parseSectionState, type SectionState } from '@/lib/sections';
import { prefsStorage } from '@/storage';

/** A collapsible section's folded and show-all state, remembered on this phone per `id`. */
export function useSectionState(id: string): [SectionState, (patch: Partial<SectionState>) => void] {
  const key = `section.${id}`;
  const [state, setState] = useState(() => parseSectionState(prefsStorage.getString(key)));
  const update = useCallback(
    (patch: Partial<SectionState>) =>
      setState((current) => {
        const next = { ...current, ...patch };
        prefsStorage.set(key, JSON.stringify(next));
        return next;
      }),
    [key],
  );
  return [state, update];
}
