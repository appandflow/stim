import { isAbsolute } from 'node:path';
import { describeDereferenced } from '../../devices/reclaim.ts';
import { isAbsentPath, isOnMountedVolume, volumeRootFor } from '../../fs-util.ts';
import type { ProjectRecord } from '../../workspace/config.ts';
import type { GcSkip } from './types.ts';

export function classifyProjectEntries(
  projects: Readonly<Record<string, ProjectRecord>>,
  mountedVolumes: string[],
): { deadProjects: string[]; invalidProjects: string[]; skipped: GcSkip[] } {
  const deadProjects: string[] = [];
  const invalidProjects: string[] = [];
  const skipped: GcSkip[] = [];
  for (const [path, project] of Object.entries(projects)) {
    if (!isAbsolute(path)) {
      const claimed = describeDereferenced(project);
      if (claimed.length) {
        skipped.push({
          dir: path,
          reason:
            `not an absolute path, so this record is invalid; kept because it still claims ${claimed.join(' and ')}; ` +
            'gc removes it once that claim is gone, or drop the entry from the config file by hand',
        });
      } else {
        invalidProjects.push(path);
      }
      continue;
    }
    if (!isAbsentPath(path)) continue;
    if (!isOnMountedVolume(path, mountedVolumes)) {
      const volume = volumeRootFor(path);
      skipped.push({ dir: path, reason: `volume ${volume} is not mounted` });
    } else {
      deadProjects.push(path);
    }
  }
  return { deadProjects, invalidProjects, skipped };
}
