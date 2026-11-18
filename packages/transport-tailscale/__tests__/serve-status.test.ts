import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serveRoute } from '../src/tailscale.ts';

const HOST = 'mac.tail.ts.net';

describe.skipIf(process.platform === 'win32')('tailscale serve status', () => {
  let dir: string;
  let binary: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'stim-tailscale-serve-'));
    binary = join(dir, 'tailscale');
    writeFileSync(binary, '#!/usr/bin/env node\nconsole.log(process.env.SERVE_STATUS);\n');
    chmodSync(binary, 0o755);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it.each([
    [
      'only a named service, with no node handler, as no route',
      {
        Services: {
          'svc:other': {
            TCP: { 443: { HTTPS: true } },
            Web: { 'other.tail.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } } },
          },
        },
      },
      { state: 'missing' },
    ],
    [
      'a node route beside a named service as that route',
      {
        TCP: { 443: { HTTPS: true } },
        Web: { [`${HOST}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:7787' } } } },
        Services: { 'svc:other': { Tun: true } },
      },
      { state: 'routed', port: 443 },
    ],
    ['a Services field that is not a map as unreadable', { Services: [] }, { state: 'unknown' }],
  ])('reads %s', async (_name, config, route) => {
    const env = { PATH: process.env.PATH, SERVE_STATUS: JSON.stringify(config) };
    expect(await serveRoute(binary, env, 7787, ['100.64.0.1'])).toMatchObject(route);
  });
});
