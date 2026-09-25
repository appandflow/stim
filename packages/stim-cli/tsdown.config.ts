import { writeFileSync } from 'node:fs';
import { defineConfig } from 'tsdown';
import { SETTINGS_SCHEMA_FILE, settingsJsonSchema } from './src/workspace/settings-schema.ts';

export default defineConfig({
  entry: {
    cli: 'bin/cli.ts',
    'android-cas-compiler': 'bin/android-cas-compiler.ts',
    'cache-manifest': 'src/cache/cache-manifest.ts',
    'supervisor-run': 'src/supervisor/run.ts',
    'collector-run': 'src/collector/run.ts',
  },
  format: 'esm',
  dts: true,
  outDir: 'dist',
  target: 'node22.12',
  platform: 'node',
  tsconfig: 'tsconfig.json',
  fixedExtension: true,
  hooks: {
    'build:done': () => {
      writeFileSync(`dist/${SETTINGS_SCHEMA_FILE}`, `${JSON.stringify(settingsJsonSchema(), null, 2)}\n`);
    },
  },
});
