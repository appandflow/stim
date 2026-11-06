import { compareVersions } from '../../bin/route.mjs';

export interface Packument {
  'dist-tags': Partial<Record<'latest' | 'next', string>>;
  versions: Record<string, { peer?: number }>;
}

export function pickUpdateVersion(packument: Packument, channel: 'latest' | 'next', peer: number): string | null {
  const tip = packument['dist-tags'][channel];
  if (!tip) return null;
  return (
    Object.entries(packument.versions)
      .filter(([version, metadata]) => {
        const order = compareVersions(version, tip);
        return (
          order !== null &&
          order <= 0 &&
          (channel === 'next' || !version.includes('-')) &&
          (metadata.peer === undefined ? version === tip : metadata.peer >= peer)
        );
      })
      .map(([version]) => version)
      .toSorted((a, b) => compareVersions(b, a) ?? 0)[0] ?? null
  );
}
