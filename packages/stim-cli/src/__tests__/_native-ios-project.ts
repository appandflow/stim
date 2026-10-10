import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildCacheKey, filesystemBuildCapability } from '../cache/build-cache.ts';
import { skippedMissReason } from '../cache/miss-reason.ts';
import { iosProcessRuntime } from '../commands/ios/launch.ts';
import { buildXcode } from '../engine/xcode.ts';
import type { ProjectIntegration } from '../integrations/project-registry.ts';

export const nativeIosFixture: ProjectIntegration = {
  id: 'test-native-ios',
  inspect(root) {
    const projectPath = join(root, 'Native.xcodeproj');
    if (!existsSync(projectPath)) return null;
    return {
      root: 'candidate',
      application: true,
      platforms: () => ['ios'],
      validate: (operation) => (operation === 'ios' ? null : undefined),
      ios: async () => ({
        isExpo: false,
        targets: ['simulator'],
        eas: false,
        bundleId: () => 'org.example.native',
        schemeProblem: () => null,
        runtimeKind: () => 'process',
        runtime: () => iosProcessRuntime(async () => ({ ok: true, prepared: { metroPort: null } })),
        artifact: ({ logWriter, configuration, target }) => {
          let hash = '';
          const sourceHash = () => {
            const digest = createHash('sha256').update('test-native-ios-v1');
            for (const file of ['Native.xcodeproj/project.pbxproj', 'Native.swift'])
              digest.update(file).update(readFileSync(join(root, file)));
            return digest.digest('hex');
          };
          const identity = () => ({
            hash,
            key: buildCacheKey('ios', hash, {
              configuration: configuration ?? 'Debug',
              scheme: 'Native',
              isSimulator: true,
              ...(target.keyArch ? { arch: target.keyArch } : {}),
            }),
          });
          return {
            identity: async () => {
              hash = sourceHash();
              return identity();
            },
            cache: () => filesystemBuildCapability(),
            prepare: async () => {},
            reconcile: async () => ({ identity: identity(), rekeyedBy: [], mutationLabel: '' }),
            validate: async () => (sourceHash() === hash ? identity() : null),
            validateExternal: () => {},
            materialize: async (path) => path,
            compile: () =>
              buildXcode({
                root,
                project: { dir: root, path: projectPath, kind: 'project', flag: '-project', name: 'Native' },
                scheme: 'Native',
                configuration: configuration ?? 'Debug',
                udid: target.udid,
                destination: target.destination,
                sdk: target.sdk,
                arch: target.arch,
                logWriter: logWriter(),
                compilationCache: null,
              }),
            explain: () => ({ reason: skippedMissReason('the native fixture source has no cached app'), diff: null }),
            untrackedLine: () => null,
            legacyCache: null,
            offload: null,
          };
        },
      }),
    };
  },
};
