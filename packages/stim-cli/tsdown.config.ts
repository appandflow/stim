import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'tsdown';
import { SETTINGS_SCHEMA_FILE, settingsJsonSchema } from '@stim-cli/core/state';

const { engines, version } = JSON.parse(readFileSync(new URL('package.json', import.meta.url), 'utf8'));
const nodeFloor = /^>=(\d+\.\d+\.\d+)$/.exec(engines.node)?.[1];
if (!nodeFloor) throw new Error(`engines.node must have the form >=X.Y.Z, got ${engines.node}`);

export default defineConfig({
  entry: {
    cli: 'bin/node-check.ts',
    api: 'src/api.ts',
    ci: '../ci/src/index.ts',
    'ci/artifacts': '../ci/src/artifacts.ts',
    'stim-server': 'bin/stim-server.ts',
    'android-cas-compiler': 'bin/android-cas-compiler.ts',
    'cache-manifest': 'src/cache/cache-manifest.ts',
    'pull-requests': 'src/pull-request-state.ts',
    'share-links': 'src/workspace/share-links.ts',
    'build-artifact-cache': 'src/offload/build-artifact-cache.ts',
    'daemon-run': 'src/daemon/run.ts',
    'passes-run': 'src/daemon/passes-run.ts',
    'supervisor-run': 'src/supervisor/run.ts',
    'collector-run': 'src/collector/run.ts',
    'web-run': 'src/web/run.ts',
    'macos-run': 'src/macos/run.ts',
    'device-host-worker': 'src/device-host/run.ts',
    'offload-worker': 'src/offload/worker.ts',
    'status-worker': 'src/status-worker.ts',
    'doctor-fingerprint': 'bin/doctor-fingerprint.ts',
    'fingerprint-precompute': 'bin/fingerprint-precompute.ts',
    'windows-report': 'bin/windows-report.ts',
  },
  format: 'esm',
  dts: true,
  outDir: 'dist',
  target: 'node22.12',
  platform: 'node',
  alias: { '@stim-cli/ci/cli': resolve('../ci/src/cli.ts') },
  noExternal: [/^@stim-cli\/ci(?:\/|$)/],
  define: { NODE_FLOOR: JSON.stringify(nodeFloor), STIM_CI_VERSION: JSON.stringify(version) },
  tsconfig: 'tsconfig.json',
  fixedExtension: true,
  hooks: {
    'build:done': () => {
      writeFileSync(`dist/${SETTINGS_SCHEMA_FILE}`, `${JSON.stringify(settingsJsonSchema(), null, 2)}\n`);
      copyFileSync('helper/stim-footprint.swift', 'dist/stim-footprint.swift');
      copyFileSync('helper/stim-clonefile.c', 'dist/stim-clonefile.c');
      copyFileSync('helper/stim-privsize.c', 'dist/stim-privsize.c');
      copyFileSync('helper/windows-report.ps1', 'dist/windows-report.ps1');
    },
  },
});
