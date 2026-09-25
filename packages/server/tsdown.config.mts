import { writeFileSync } from 'node:fs';
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
    },
  },
});
