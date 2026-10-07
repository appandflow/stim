export type ArchiveKind = 'logs' | 'recordings' | 'agentActions';

const KIND_SELECTORS: Record<string, ArchiveKind> = {
  'archived-logs': 'logs',
  'archived-recordings': 'recordings',
  'archived-agent': 'agentActions',
};

export function parseArchiveSelector(scope: string): { kind: ArchiveKind | null; id: string | null } | null {
  const trimmed = scope.trim();
  const colon = trimmed.indexOf(':');
  const name = (colon === -1 ? trimmed : trimmed.slice(0, colon)).toLowerCase();
  const id = colon === -1 ? null : trimmed.slice(colon + 1);
  if (name === 'archived') return { kind: null, id };
  const kind = KIND_SELECTORS[name];
  return kind ? { kind, id } : null;
}
