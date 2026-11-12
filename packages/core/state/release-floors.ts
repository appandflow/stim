import floors from './release-floors.json' with { type: 'json' };

/** A floor the release prep pins at the cut; null until then. */
export function pinnedReleaseFloor(name: 'stimd'): string | null {
  return floors[name];
}
