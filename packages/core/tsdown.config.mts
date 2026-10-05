import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    index: 'index.ts',
    'ownership-claim': 'ownership-claim.ts',
    'process-identity': 'process-identity.ts',
    state: 'state/index.ts',
    protocol: 'protocol.ts',
    'phone-protocol': 'phone-protocol.ts',
    'receive-protocol': 'receive-protocol.ts',
    oversight: 'oversight.ts',
  },
  format: 'esm',
  dts: true,
  outDir: 'dist',
  target: 'node22.12',
  platform: 'node',
  tsconfig: 'tsconfig.json',
  fixedExtension: true,
});
