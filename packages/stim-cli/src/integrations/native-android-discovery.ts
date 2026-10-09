import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectIntegration } from './project-registry.ts';

export const nativeAndroidIntegration: ProjectIntegration = {
  id: 'native-android',
  inspect(root) {
    if (
      !['settings.gradle', 'settings.gradle.kts'].some((name) => existsSync(join(root, name))) ||
      !['gradlew', 'gradlew.bat'].some((name) => existsSync(join(root, name)))
    )
      return null;
    return {
      root: 'candidate',
      application: true,
      platforms: () => ['android'],
      validate: (operation) => (operation === 'android' ? null : undefined),
      android: async () => (await import('./native-android.ts')).nativeAndroidProject(root),
      doctor: async () => (await import('./native-android.ts')).nativeAndroidDoctor(root),
    };
  },
};
