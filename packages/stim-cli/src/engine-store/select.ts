import { compareVersions } from '../../bin/route.mjs';
import type { Current, StoreState } from './store.ts';

/**
 * Why `engine-select` keeps the engine off `target`, or null. Unattended promotions stop at a pin, at or below the
 * newest build marked bad, at a version that is not newer, and at a prerelease while the engine follows `latest`;
 * a person's `stim engine use|update|rollback` is `explicit` and passes.
 */
export function promotionRefusal(
  target: { version: string },
  current: Current | null,
  bad: StoreState['bad'],
  explicit: boolean,
): string | null {
  if (explicit) return null;
  if (!current) return 'no engine is installed; run stim engine install';
  if (current.pinned)
    return `the engine is pinned at ${current.version} (${current.pinReason}); run stim engine update to resume updates`;
  const newestBad = bad
    .map((each) => each.version)
    .toSorted((a, b) => compareVersions(a, b) ?? 0)
    .at(-1);
  if (newestBad && (compareVersions(target.version, newestBad) ?? 1) <= 0)
    return `${target.version} is marked bad (crash loop); the engine stays on ${current.version}`;
  if ((compareVersions(target.version, current.version) ?? 0) <= 0)
    return `${target.version} is not newer than the engine (${current.version})`;
  if (target.version.includes('-') && current.channel === 'latest')
    return `${target.version} is a prerelease and the engine follows latest; run stim engine use --channel next`;
  return null;
}
