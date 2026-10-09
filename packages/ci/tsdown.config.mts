import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsdown';

const { version } = JSON.parse(readFileSync(new URL('package.json', import.meta.url), 'utf8'));

export default defineConfig({
  entry: { index: 'src/index.ts', 'stim-ci': 'bin/node-check.ts' },
  format: 'esm',
  dts: true,
  outDir: 'dist',
  target: 'node22.12',
  platform: 'node',
  define: { STIM_CI_VERSION: JSON.stringify(version) },
  tsconfig: 'tsconfig.json',
  fixedExtension: true,
});
