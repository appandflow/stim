import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: { index: 'index.ts', 'credentials-worker': 'credentials-worker.ts', 'extract-worker': 'extract-worker.ts' },
  format: 'esm',
  dts: true,
  outDir: 'dist',
  target: 'node22.12',
  platform: 'node',
  tsconfig: 'tsconfig.json',
  fixedExtension: true,
});
