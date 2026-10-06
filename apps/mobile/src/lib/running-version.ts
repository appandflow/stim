import { t } from '@lingui/core/macro';
import Constants from 'expo-constants';
import * as Updates from 'expo-updates';

import { formatDateTime } from '@/intl/format';
import { shortId, versionWithBuild } from '@/lib/about';

export function runningVersion({
  version,
  build,
  updateId,
  createdAt,
  isEmbeddedLaunch,
}: {
  version: string;
  build: string | null;
  updateId: string | null;
  createdAt: Date | null;
  isEmbeddedLaunch: boolean;
}): { version: string; update: string } {
  const appVersion = versionWithBuild({ version, build });
  const id = updateId ? shortId(updateId) : null;
  const date = createdAt ? formatDateTime(createdAt, { dateStyle: 'medium' }) : null;
  return {
    version: t`Stim ${appVersion}`,
    update: isEmbeddedLaunch || !id ? t`Built-in` : date ? t`Update ${id}, ${date}` : t`Update ${id}`,
  };
}

export function getRunningVersion(): { version: string; update: string } {
  return runningVersion({
    version: Constants.expoConfig?.version ?? '',
    build: Constants.nativeBuildVersion,
    updateId: Updates.updateId,
    createdAt: Updates.createdAt,
    isEmbeddedLaunch: Updates.isEmbeddedLaunch,
  });
}
