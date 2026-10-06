import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { defineConfig } from 'tsdown';
import { SETTINGS_SCHEMA_FILE, settingsJsonSchema } from '@stim-cli/core/state';

const { engines } = JSON.parse(readFileSync(new URL('package.json', import.meta.url), 'utf8'));
const nodeFloor = /^>=(\d+\.\d+\.\d+)$/.exec(engines.node)?.[1];
if (!nodeFloor) throw new Error(`engines.node must have the form >=X.Y.Z, got ${engines.node}`);

export default defineConfig({
  entry: {
    cli: 'bin/node-check.ts',
    'android-cas-compiler': 'bin/android-cas-compiler.ts',
    'cache-manifest': 'src/cache/cache-manifest.ts',
    'pull-requests': 'src/workspace/pull-request.ts',
    'maintenance-run': 'src/maintenance/run.ts',
    'supervisor-run': 'src/supervisor/run.ts',
    'collector-run': 'src/collector/run.ts',
    'web-run': 'src/web/run.ts',
    'macos-run': 'src/macos/run.ts',
    'device-host-worker': 'src/device-host/run.ts',
    'offload-worker': 'src/offload/worker.ts',
  },
  format: 'esm',
  dts: true,
  outDir: 'dist',
  target: 'node22.12',
  platform: 'node',
  define: { NODE_FLOOR: JSON.stringify(nodeFloor) },
  tsconfig: 'tsconfig.json',
  fixedExtension: true,
  hooks: {
    'build:done': () => {
      writeFileSync(`dist/${SETTINGS_SCHEMA_FILE}`, `${JSON.stringify(settingsJsonSchema(), null, 2)}\n`);
      copyFileSync('helper/stim-footprint.swift', 'dist/stim-footprint.swift');
    },
  },
});
