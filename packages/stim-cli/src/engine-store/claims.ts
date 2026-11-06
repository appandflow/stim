import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readClaimSet, type ClaimSurvey } from '@stim-cli/core/ownership-claim';
import { BUILD_DIR } from './store.ts';

type Survey = Pick<ClaimSurvey, 'live' | 'unresolved'>;
/** The claims under one build's claim root. */
export type BuildClaims = { build: string; survey: Survey };

/**
 * The shared claim root of the stimds that run `build` from the store at `root`. The build is in the path, so only
 * that build reads the `drained` and `engineDirs` details its own stimds write.
 */
export const buildClaimRoot = (root: string, build: string): string => join(root, 'claims', build);

/** Whether a build's stimds have drained: no claim is unresolved and every live claim records `drained`. */
export const allDrained = ({ live, unresolved }: Survey): boolean =>
  unresolved.length === 0 && live.every((claim) => claim.details.drained === true);

/** Every build's stimd claims under `root`; a claim root that cannot be read counts as one unresolved claim. */
export function readBuildClaims(root: string): BuildClaims[] {
  let builds: string[];
  if (!existsSync(join(root, 'claims'))) return [];
  try {
    builds = readdirSync(join(root, 'claims'));
  } catch (error) {
    return [{ build: '', survey: { live: [], unresolved: [{ path: join(root, 'claims'), reason: String(error) }] } }];
  }
  return builds
    .filter((build) => BUILD_DIR.test(build))
    .map((build) => ({
      build,
      survey: readClaimSet(buildClaimRoot(root, build)),
    }));
}

/** Whether any stimd claim under the root is live or cannot be resolved: then a new build is staged, not flipped. */
export const claimsHeld = (claims: BuildClaims[]): boolean =>
  claims.some(({ survey }) => survey.live.length > 0 || survey.unresolved.length > 0);

/**
 * The store entries GC keeps: current, previous and staged; every build with a live or unresolved stimd claim; and
 * every `engineDirs` entry a live claim records, the builds its home's supervisors and collectors run.
 */
export function keptEntries(
  records: { current: { dir: string } | null; previous: string | null; staged: { dir: string } | null },
  claims: BuildClaims[],
): Set<string> {
  const kept = new Set<string>();
  for (const dir of [records.current?.dir, records.previous, records.staged?.dir]) if (dir) kept.add(dir);
  for (const { build, survey } of claims) {
    if (survey.live.length > 0 || survey.unresolved.length > 0) kept.add(build);
    for (const claim of survey.live)
      for (const dir of Array.isArray(claim.details.engineDirs) ? claim.details.engineDirs : [])
        if (typeof dir === 'string') kept.add(dir);
  }
  return kept;
}
