import type { KnipConfig } from 'knip';

export default ({ production }: { production?: boolean }): KnipConfig => ({
  ignoreExportsUsedInFile: production,
  ignore: [
    'website/**',
    'packages/core/receive-validators.mjs',
    'packages/core/receive-validators.d.mts',
    'packages/stim-cli/shim/**',
    'scripts/agent-benchmark/compat/ps-bridge.mjs',
    'scripts/agent-benchmark/stamp.mjs',
    'scripts/agent-benchmark/watch-app.mjs',
    ...(production ? ['**/__tests__/**', 'scripts/**', 'test/**', 'vitest.*.ts', 'apps/mobile/mock-server/**'] : []),
  ],
  // Test-only exports in apps/mobile, https://github.com/appandflow/stim/issues/3463
  ignoreIssues: {
    // nitrogen reads the view's type from the spec; nothing imports it.
    'apps/mobile/modules/stim-session/src/specs/StimSession.nitro.ts': ['types'],
    ...(production
      ? {
          'apps/mobile/src/lib/needs-attention.ts': ['exports', 'types'],
          'apps/mobile/src/lib/workspaces.ts': ['exports'],
        }
      : {}),
  },
  workspaces: {
    '.': {
      entry: [
        'apps/desktop/scripts/*.mjs!',
        'packaging/store/assemble.mjs',
        'scripts/ci/app-smoke.mjs',
        'scripts/agent-benchmark/native-driver.mjs',
        'scripts/agent-benchmark/native-fixtures.mjs',
      ],
    },
    'packages/stim-cli': {
      // supervisor/server-bare.ts loads @stim-cli/metro with createRequire at runtime.
      ignoreDependencies: production ? ['@stim-cli/metro'] : [],
    },
    'packages/server': {
      ignoreBinaries: ['plutil', 'ditto', 'mkfifo'],
    },
    'apps/mobile': {
      entry: [
        'plugins/*.js',
        'scripts/*.mjs',
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
      ignoreDependencies: ['cloudflare'],
    },
  },
});
