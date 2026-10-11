import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: { index: 'index.ts', s3: 's3.ts' },
  format: 'esm',
  dts: true,
  outDir: 'dist',
  target: 'node22.12',
  platform: 'node',
  tsconfig: 'tsconfig.json',
  fixedExtension: true,
});
