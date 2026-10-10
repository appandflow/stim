import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DoctorPlatform, Finding } from './doctor.ts';

import { sharedBuildCache, workspaceDerivedData } from '../workspace/paths.ts';
import { filesystemDevice, temporaryRoot } from '../temporary.ts';
import { repoRoot, resolveSourceCheckout } from '../workspace/worktree.ts';
import { apkOutputsDir } from '../integrations/react-native-build.ts';
import { DEFAULT_IOS_PROJECT_PATH } from '../workspace/settings.ts';

export function checkStorageLayout(
  projectRoot: string,
  {
    platform,
    iosProjectPath = DEFAULT_IOS_PROJECT_PATH,
    host = process.platform,
    device = filesystemDevice,
    stagingRoot = temporaryRoot,
    scope,
  }: {
    platform?: DoctorPlatform;
    iosProjectPath?: string;
    host?: NodeJS.Platform;
    device?: typeof filesystemDevice;
    stagingRoot?: typeof temporaryRoot;
    scope?: 'shared' | 'native';
  } = {},
): Finding[] {
  const findings: Finding[] = [];
  const temporaryFix =
    'Unset STIM_TMPDIR / machine tempDir to select same-volume staging automatically, ' +
    'or point the override at a writable directory on the relevant volume outside Git working trees.';
  const check = (operation: string, paths: string[], fix: string) => {
    if (new Set(paths.map(device)).size < 2) return;
    findings.push({
      level: 'cost',
      title: `${operation} crosses filesystems`,
      detail:
        `${paths.join(' -> ')}. These copies cannot share file blocks across volumes and can consume the full ` +
        'artifact size in space and I/O. cp -c can silently perform a full copy without an error.',
      fix,
    });
  };
  try {
    const cache = sharedBuildCache();
    if (scope !== 'native') {
      const target = repoRoot(projectRoot) ?? projectRoot;
      const source = resolveSourceCheckout(target);
      check(
        'Worktree copy',
        ['path' in source ? source.path : target, target],
        'Keep the source checkout and linked worktree on the same volume to share file blocks when warming.',
      );
      check('Cached app/APK staging', [cache, stagingRoot(join(cache, 'artifact.app'))], temporaryFix);
    }
    const cacheFix =
      'Place STIM_BUILD_CACHE / machine caches.buildCache on the build-output volume, ' +
      'or accept the full-copy cost of keeping the cache on a separate volume.';
    const localIos = platform === 'ios' || (platform !== 'android' && existsSync(join(projectRoot, iosProjectPath)));
    if (scope !== 'shared' && localIos && host === 'darwin') {
      const output = join(workspaceDerivedData(projectRoot), 'Build', 'Products');
      check('iOS build-cache storage', [output, cache], cacheFix);
      check('iOS device app staging', [output, stagingRoot(join(output, 'artifact.app'))], temporaryFix);
    }
    if (
      scope !== 'shared' &&
      (platform === 'android' || (platform !== 'ios' && existsSync(join(projectRoot, 'android'))))
    ) {
      check('Android build-cache storage', [apkOutputsDir(projectRoot), cache], cacheFix);
    }
  } catch (error) {
    findings.push({
      level: 'cost',
      title: 'Could not resolve temporary storage',
      detail: String((error as Error).message),
      fix: temporaryFix,
    });
  }
  return findings;
}
