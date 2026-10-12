import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DoctorContext, DoctorPlatform, Finding } from './doctor.ts';

import { sharedBuildCache, workspaceDerivedData } from '../workspace/paths.ts';
import { filesystemDevice, temporaryRoot } from '../temporary.ts';
import { resolveSourceCheckoutAsync } from '../workspace/worktree.ts';
import { apkOutputsDir } from '../integrations/react-native-build.ts';
import { DEFAULT_IOS_PROJECT_PATH, defaultAndroidLayout, type AndroidLayout } from '../workspace/settings.ts';

const temporaryFix =
  'Unset STIM_TMPDIR / machine tempDir to select same-volume staging automatically, ' +
  'or point the override at a writable directory on the relevant volume outside Git working trees.';

function crossFilesystem(
  operation: string,
  paths: string[],
  fix: string,
  device: typeof filesystemDevice,
): Finding | null {
  if (new Set(paths.map(device)).size < 2) return null;
  return {
    level: 'cost',
    title: `${operation} crosses filesystems`,
    detail:
      `${paths.join(' -> ')}. These copies cannot share file blocks across volumes and can consume the full ` +
      'artifact size in space and I/O. cp -c can silently perform a full copy without an error.',
    fix,
  };
}

function storageFailure(error: unknown): Finding {
  return {
    level: 'cost',
    title: 'Could not resolve temporary storage',
    detail: String((error as Error).message),
    fix: temporaryFix,
  };
}

export async function checkWorktreeStorageLayout(
  { root, repoRoot, options }: Pick<DoctorContext, 'root' | 'repoRoot' | 'options'>,
  { device = filesystemDevice }: { device?: typeof filesystemDevice } = {},
): Promise<Finding[]> {
  if (options.machineSettings?.corrupt) return [];
  try {
    const target = repoRoot ?? root;
    const source = await resolveSourceCheckoutAsync(target);
    const finding = crossFilesystem(
      'Worktree copy',
      ['path' in source ? source.path : target, target],
      'Keep the source checkout and linked worktree on the same volume to share file blocks when warming.',
      device,
    );
    return finding ? [finding] : [];
  } catch (error) {
    return [storageFailure(error)];
  }
}

export function checkStorageLayout(
  projectRoot: string,
  {
    platform,
    iosProjectPath = DEFAULT_IOS_PROJECT_PATH,
    androidLayout = defaultAndroidLayout(projectRoot),
    host = process.platform,
    device = filesystemDevice,
    stagingRoot = temporaryRoot,
    scope,
  }: {
    platform?: DoctorPlatform;
    iosProjectPath?: string;
    androidLayout?: AndroidLayout;
    host?: NodeJS.Platform;
    device?: typeof filesystemDevice;
    stagingRoot?: typeof temporaryRoot;
    scope?: 'shared' | 'native';
  } = {},
): Finding[] {
  const findings: Finding[] = [];
  const check = (operation: string, paths: string[], fix: string) => {
    const finding = crossFilesystem(operation, paths, fix, device);
    if (finding) findings.push(finding);
  };
  try {
    const cache = sharedBuildCache();
    if (scope !== 'native') {
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
      (platform === 'android' || (platform !== 'ios' && existsSync(androidLayout.gradleRoot)))
    ) {
      check('Android build-cache storage', [apkOutputsDir(androidLayout), cache], cacheFix);
    }
  } catch (error) {
    findings.push(storageFailure(error));
  }
  return findings;
}
