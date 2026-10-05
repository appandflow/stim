import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stimBuildDigest } from '@stim-cli/core/state';
import { WebSocketServer } from 'ws';
import { MachineUpdates, packWorkspace, publishedRange, workspacePackages } from '../src/machine-update.ts';

const SERVER = join(import.meta.dirname, '..');

describe('client build packing', () => {
  it('publishes workspace ranges as pnpm does', () => {
    expect(publishedRange('workspace:*', '1.14.0')).toBe('1.14.0');
    expect(publishedRange('workspace:^', '1.14.0')).toBe('^1.14.0');
    expect(publishedRange('workspace:~', '1.14.0')).toBe('~1.14.0');
    expect(publishedRange('workspace:^1.2.0', '1.14.0')).toBe('^1.2.0');
  });

  it('finds every workspace package the server reaches from a checkout, and none from an installed package', () => {
    expect([...workspacePackages(SERVER)!.keys()].toSorted()).toEqual([
      '@stim-cli/cache',
      '@stim-cli/core',
      '@stim-cli/metro',
      '@stim-cli/server',
      'stim',
    ]);
    expect(workspacePackages(join(SERVER, 'node_modules', '@stim-cli', 'server'))).toBeNull();
  });

  describe.skipIf(process.platform !== 'darwin')('with tar', () => {
    it('packs the stim build a build machine must match, with published ranges', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'stim-pack-test-'));
      try {
        const packed = await packWorkspace(workspacePackages(SERVER)!);
        const stim = packed.find((each) => /^stim-\d/.test(each.name))!;
        writeFileSync(join(dir, stim.name), stim.bytes);
        execFileSync('/usr/bin/tar', ['-xzf', join(dir, stim.name), '-C', dir]);
        const manifest = JSON.parse(readFileSync(join(dir, 'package', 'package.json'), 'utf8'));
        expect(manifest.dependencies['@stim-cli/core']).toMatch(/^\^\d/);
        expect(manifest.devDependencies).toBeUndefined();
        expect(stimBuildDigest(join(dir, 'package', 'dist'))).toBe(
          stimBuildDigest(join(SERVER, '..', 'stim-cli', 'dist')),
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

describe('asking a build machine to update', () => {
  const TOKEN = 'token-that-must-not-leak';
  let home: string;
  let host: WebSocketServer;
  let calls: { method: string; params: Record<string, unknown> }[];

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'stim-machine-update-'));
    process.env.STIM_HOME = home;
    writeFileSync(
      join(home, 'build-machines.json'),
      JSON.stringify({
        version: 1,
        machines: [
          {
            machine: 'mini',
            nodeId: 'nMini',
            dnsName: 'mini.tail.ts.net',
            deviceId: 'd1',
            deviceToken: TOKEN,
            state: 'approved',
            requestedAt: '2026-10-05T00:00:00.000Z',
          },
        ],
      }),
    );
    calls = [];
    host = new WebSocketServer({ port: 0 });
    host.on('connection', (socket) =>
      socket.on('message', (data) => {
        const { id, method, params } = JSON.parse(data.toString());
        calls.push({ method, params });
        const reply = (body: object) => socket.send(JSON.stringify({ id, ...body }));
        if (method === 'hello') return reply({ result: { capabilities: ['build'], features: ['server-update'] } });
        if (method === 'server.update.status')
          return reply({ error: { code: 'forbidden', message: `refused ${TOKEN}` } });
        if (method === 'server.update.chunk') return reply({ result: { state: 'uploading' } });
        reply({ result: { id: 'u1', state: 'release' in params ? 'installing' : 'uploading', startedAt: 'now' } });
      }),
    );
    await new Promise((resolve) => host.once('listening', resolve));
  });

  afterEach(async () => {
    await new Promise((resolve) => host.close(resolve));
    delete process.env.STIM_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  const updates = (serverDir: string) =>
    new MachineUpdates({
      version: '1.14.0',
      serverDir,
      status: () => ({ Peer: { a: { ID: 'nMini', DNSName: 'mini.tail.ts.net.', TailscaleIPs: ['100.64.0.9'] } } }),
      endpoint: (pinned) => ({ ...pinned, url: `ws://127.0.0.1:${(host.address() as { port: number }).port}` }),
    });

  it('asks an installed server for the same npm release, and never repeats the token in an error', async () => {
    const machine = updates(join(SERVER, 'node_modules', '@stim-cli', 'server'));
    expect(await machine.start('mini')).toMatchObject({ result: { state: 'installing' } });
    expect(calls.map((call) => call.method)).toEqual(['hello', 'server.update.start']);
    expect(calls[1]!.params).toEqual({ release: '1.14.0' });
    const status = await machine.status('mini');
    expect(status).toMatchObject({ result: { remote: null, upload: null } });
    expect(JSON.stringify(status)).not.toContain(TOKEN);
    expect(JSON.stringify(status)).toContain('[redacted]');
    expect(await machine.start('other')).toMatchObject({
      error: { message: expect.stringContaining('has not approved') },
    });
  });

  describe.skipIf(process.platform !== 'darwin')('from a checkout', () => {
    it('uploads every packed package in order from a checkout', async () => {
      const machine = updates(SERVER);
      expect(await machine.start('mini')).toMatchObject({ result: { state: 'uploading' } });
      await vi.waitFor(
        async () => {
          const status = await machine.status('mini');
          expect((status as { result: { upload: { sent: number; total: number } } }).result.upload.sent).toBe(
            (status as { result: { upload: { sent: number; total: number } } }).result.upload.total,
          );
        },
        { timeout: 30_000 },
      );
      const offered = calls.find((call) => call.method === 'server.update.start')!.params.packages as {
        name: string;
        size: number;
      }[];
      expect(offered.map((each) => each.name.replace(/-\d.*$/, '')).toSorted()).toEqual([
        'stim',
        'stim-cli-cache',
        'stim-cli-core',
        'stim-cli-metro',
        'stim-cli-server',
      ]);
      for (const { name, size } of offered) {
        const chunks = calls.filter((call) => call.method === 'server.update.chunk' && call.params.name === name);
        let offset = 0;
        for (const chunk of chunks) {
          expect(chunk.params.offset).toBe(offset);
          offset += Buffer.from(chunk.params.data as string, 'base64').length;
        }
        expect(offset).toBe(size);
      }
    }, 60_000);
  });
});
