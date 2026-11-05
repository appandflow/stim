import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: { main: 'src/main.ts' },
  format: 'esm',
  dts: false,
  outDir: 'dist',
  target: 'node24',
  platform: 'node',
  deps: { alwaysBundle: [/.*/], onlyBundle: false },
  fixedExtension: true,
});
