import floors from './release-floors.json' with { type: 'json' };

/** Resolves an unpinned floor from the engine's build version; pinned floors never move. */
export function releaseFloor(name: 'oneEngine', version: string): string {
  const floor: string | null = floors[name];
  if (floor !== null) return floor;
  const [major, minor] = version.split(/[.-]/);
  return `${major}.${Number(minor) + (version.includes('-') ? 0 : 1)}.0`;
}
