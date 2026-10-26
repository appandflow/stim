/**
 * The placement words every workload shares (`remote.build`, `ios.remote`, `android.remote`, `macos.remote` and their
 * flags). Anything else a setting holds is a machine name, or for devices `eas` or `proxy`.
 *
 * - `local`: this machine only.
 * - `auto`: this machine first, a remote machine when this one is full or busy.
 * - `remote`: remote machines first, in `remote.machines` order; this machine only when none takes the run.
 * - `remote-only`: remote machines in `remote.machines` order, never this machine.
 */
export const PLACEMENT_WORDS = ['local', 'auto', 'remote', 'remote-only'] as const;

export type PlacementWord = (typeof PLACEMENT_WORDS)[number];

export type AutomaticPlacement = Exclude<PlacementWord, 'local'>;

export function placementWord(value: string): PlacementWord | null {
  const word = value.trim().toLowerCase();
  return PLACEMENT_WORDS.find((each) => each === word) ?? null;
}

export function prefersRemote(word: PlacementWord): boolean {
  return word === 'remote' || word === 'remote-only';
}

export function mayRunHere(word: PlacementWord): boolean {
  return word !== 'remote-only';
}
