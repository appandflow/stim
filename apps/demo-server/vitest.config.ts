import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { 'cloudflare:workers': new URL('test/cloudflare-workers.ts', import.meta.url).pathname } },
  test: {
    globals: true,
    environment: 'node',
    include: ['test/*.test.ts'],
  },
});
