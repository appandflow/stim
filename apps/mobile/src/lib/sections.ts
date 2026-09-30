import { t } from '@lingui/core/macro';

/** Rows a capped section shows before "Show all", as on Stim Desktop's Machine page. */
const SECTION_LIMIT = 10;

export interface SectionState {
  collapsed: boolean;
  showAll: boolean;
}

const DEFAULT_SECTION: SectionState = { collapsed: false, showAll: false };

/** A saved section state; anything unreadable is the default, expanded and capped. */
export function parseSectionState(raw: string | undefined): SectionState {
  if (!raw) return DEFAULT_SECTION;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return DEFAULT_SECTION;
    const { collapsed, showAll } = value as Record<string, unknown>;
    return { collapsed: collapsed === true, showAll: showAll === true };
  } catch {
    return DEFAULT_SECTION;
  }
}

/** The rows the section shows, and the toggle under them: none when every row fits under the cap. */
export function sectionRows<T>(
  rows: readonly T[],
  showAll: boolean,
  limit = SECTION_LIMIT,
): { shown: T[]; toggle: string | null } {
  if (rows.length <= limit) return { shown: [...rows], toggle: null };
  if (showAll) return { shown: [...rows], toggle: t`Show fewer` };
  const count = rows.length;
  return { shown: rows.slice(0, limit), toggle: t`Show all ${count}` };
}
