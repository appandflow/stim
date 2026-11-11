import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: { index: 'index.ts', 'agent-device-bin': 'agent-device-bin.ts' },
  format: 'esm',
  dts: true,
  outDir: 'dist',
  target: 'node22.12',
  platform: 'node',
  tsconfig: 'tsconfig.json',
  fixedExtension: true,
});
