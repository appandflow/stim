import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { defineConfig } from 'tsdown';
import { PROTOCOL_SCHEMA_FILE, protocolJsonSchema } from './src/protocol.ts';

export default defineConfig({
  entry: {
    'stim-server': 'bin/stim-server.ts',
    protocol: 'src/protocol.ts',
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
      writeFileSync(`dist/${PROTOCOL_SCHEMA_FILE}`, `${JSON.stringify(protocolJsonSchema(), null, 2)}\n`);
      rmSync('dist/stim-frames', { recursive: true, force: true });
      mkdirSync('dist/stim-frames');
      const desktop = readFileSync('helper/desktop-sources.txt', 'utf8').split(/\s+/).filter(Boolean);
      for (const source of [
        'helper/main.swift',
        'helper/VideoEncoder.swift',
        ...desktop.map((path) => `../../apps/desktop/Sources/${path}`),
      ]) {
        copyFileSync(source, `dist/stim-frames/${basename(source)}`);
      }
      copyFileSync('../../apps/desktop/Support/SimFold/main.m', 'dist/stim-frames/sim-fold.m');
      copyFileSync('../../apps/desktop/Support/SimFold/entitlements.plist', 'dist/stim-frames/sim-fold.entitlements');
    },
  },
});
