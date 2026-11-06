import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: { index: 'index.ts', contract: 'contract.ts', tiers: 'tiers.ts' },
  format: 'esm',
  dts: true,
  outDir: 'dist',
  target: 'node22.12',
  platform: 'node',
  tsconfig: 'tsconfig.json',
  fixedExtension: true,
});
