import { existsSync } from 'node:fs';
import type { KnipConfig } from 'knip';

export default ({ production }: { production?: boolean }): KnipConfig => ({
  ignoreExportsUsedInFile: production,
  ignore: [
    'website/**',
    ...(existsSync(new URL('apps/desktop/.build', import.meta.url)) ? ['apps/desktop/.build/**'] : []),
    'packages/core/receive-validators.mjs',
    'packages/core/receive-validators.d.mts',
    'packages/stim-cli/shim/**',
    'packages/stim-cli/src/injected/*.d.cts',
    'scripts/agent-benchmark/stamp.mjs',
    'scripts/agent-benchmark/watch-app.mjs',
    ...(production ? ['**/__tests__/**', 'scripts/**', 'test/**', 'vitest.*.ts', 'apps/mobile/mock-server/**'] : []),
  ],
  ignoreIssues: {
    // nitrogen reads the view's type from the spec; nothing imports it.
    'apps/mobile/modules/stim-session/src/specs/StimSession.nitro.ts': ['types'],
  },
  workspaces: {
    '.': {
      ignoreBinaries: ['adb', 'chflags'],
      entry: [
        'apps/desktop/scripts/*.mjs!',
        'apps/desktop/Tests/StimKitTests/Fixtures/noise-responder.mjs',
        'packaging/store/assemble.mjs',
        'scripts/ci/app-smoke.mjs',
        'scripts/perf/bench.mjs',
        'scripts/perf/compare.mjs',
        'scripts/resource-model-e2e/run.mjs',
        'scripts/resource-model-e2e/sampler.mjs',
        'scripts/build-android-audio.mjs',
        'scripts/fingerprint-parity.mjs',
        'scripts/fingerprint-drift.mjs',
        'scripts/agent-benchmark/native-driver.mjs',
        'scripts/agent-benchmark/native-fixtures.mjs',
      ],
    },
    'packages/stim-cli': {
      // TypeScript reads it as the declarations of bin/route.mjs, which the published router imports.
      ignore: ['bin/route.d.mts'],
      entry: ['src/injected/*.cjs'],
      // tsdown bundles the workspace packages; their bare unique-pid import stays external.
      ignoreDependencies: production ? ['@stim-cli/*', 'unique-pid'] : [],
    },
    'packages/cache-s3': {
      // https://github.com/webpro-nl/knip/pull/2218: strict mode rejects published optional peer types.
      ignoreDependencies: production ? ['stim'] : [],
    },
    'packages/server': {
      ignore: ['share-viewer/**'],
      ignoreBinaries: ['plutil', 'ditto', 'mkfifo'],
    },
    'apps/mobile': {
      entry: [
        'plugins/*.js',
        'scripts/*.mjs',
        // Run by the stim-session podspec and CMakeLists.txt.
        'modules/stim-session/scripts/*.mjs',
        'mock-server/*.mjs',
        'fingerprint.config.js',
        'lingui.config.js',
        'store.config.js',
      ],
      ignoreBinaries: ['stim-server', 'cc', 'c\\+\\+'],
      ignoreDependencies: ['expo-screen-orientation', '@expo/fingerprint'],
      ignoreExportsUsedInFile: production || {
        interface: true,
        type: true,
      },
    },
    'test/mobile-e2e': {
      entry: ['e2e.config.ts', 'tests/*.e2e.ts'],
      ignoreBinaries: ['stim', 'e2e'],
      ignoreDependencies: ['ai'],
    },
    'apps/demo-server': {
      entry: ['scripts/*.mjs'],
      ignoreDependencies: ['cloudflare'],
    },
  },
});
