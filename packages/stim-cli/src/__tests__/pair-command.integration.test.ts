import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { releaseClaim, tryAcquireClaim, type ClaimHandle } from '@stim-cli/core/ownership-claim';
import { stimdClaimRoot, stimdRunDir, stimdSocket } from '@stim-cli/core/state';
import type { TailscaleState } from '@stim-cli/transport-tailscale';

const tailscale = vi.hoisted(() => {
  const fixture: { binary: string | null; state: TailscaleState } = {
    binary: null,
    state: { state: 'unavailable', reason: 'fixture' },
  };
  return fixture;
});

vi.mock('@stim-cli/transport-tailscale', async (original) => ({
  ...(await original<typeof import('@stim-cli/transport-tailscale')>()),
  findTailscale: () => tailscale.binary,
  readTailscaleStatus: async () => tailscale.state,
  serveRoute: async () => ({ state: 'missing', port: 7443 }),
}));

let home: string;
let server: Server | null = null;
let claim: ClaimHandle | null = null;
let errors: string[];
let printed: string[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-pair-command-'));
  process.env.STIM_HOME = home;
  errors = [];
  printed = [];
  tailscale.binary = null;
  tailscale.state = { state: 'unavailable', reason: 'fixture' };
  vi.spyOn(console, 'error').mockImplementation((line: unknown) => void errors.push(String(line)));
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => void printed.push(String(line)));
});

afterEach(async () => {
  await new Promise((done) => (server ? server.close(done) : done(undefined)));
  server = null;
  releaseClaim(claim);
  claim = null;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  delete process.env.STIM_HOME;
  rmSync(home, { recursive: true, force: true });
});

async function pair(): Promise<void> {
  vi.resetModules();
  const { default: pairOp } = await import('../commands/pair.ts');
  const { runCli } = await import('../cli/define-op.ts');
  await runCli(pairOp, ['--control'], { version: '0.0.0' });
}

test('a stimd of another Stim build is named, not reported as missing', async () => {
  const socket = stimdSocket();
  mkdirSync(dirname(socket), { recursive: true, mode: 0o700 });
  mkdirSync(stimdRunDir(), { recursive: true, mode: 0o700 });
  claim = tryAcquireClaim({ root: stimdClaimRoot(), mode: 'exclusive', label: 'test stimd' }).acquired ?? null;
  server = createServer((connection) => {
    connection.resume();
    connection.end(`${JSON.stringify({ op: 'engine-changed', build: 'aaaaaaaaaaaa' })}\n`);
  });
  await new Promise<void>((done) => server?.listen(socket, done));

  await pair();

  expect(errors.join('\n')).toContain("This Stim home's stimd runs another Stim build");
  expect(errors.join('\n')).not.toContain('No stimd runs');
});

test('without a stimd, and none it may start, the pairing says no stimd runs', async () => {
  vi.stubEnv('STIM_DAEMON', 'off');

  await pair();

  expect(errors.join('\n')).toContain('No stimd runs to take this pairing; run stim serve.');
});

test('a server that serves this machine only refuses a tailnet pairing without issuing a token', async () => {
  tailscale.binary = '/fake/tailscale';
  tailscale.state = { state: 'running', ips: ['100.64.0.9'], dnsName: 'mac.tail.ts.net', hostName: 'mac' };
  const socket = stimdSocket();
  mkdirSync(dirname(socket), { recursive: true, mode: 0o700 });
  mkdirSync(stimdRunDir(), { recursive: true, mode: 0o700 });
  claim = tryAcquireClaim({ root: stimdClaimRoot(), mode: 'exclusive', label: 'test stimd' }).acquired ?? null;
  server = createServer((connection) => {
    let lines = 0;
    connection.setEncoding('utf8');
    connection.on('data', (chunk: string) => {
      for (const _ of chunk.matchAll(/\n/g)) {
        lines++;
        connection.write(
          `${JSON.stringify(lines === 1 ? { op: 'hello' } : { op: 'net', listening: true, port: 7787, loopbackOnly: true })}\n`,
        );
      }
    });
  });
  await new Promise<void>((done) => server?.listen(socket, done));
  vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new Error(`exit ${String(code)}`);
  });

  await pair().catch(() => {});

  expect(errors.join('\n')).toContain('serves this machine only, so a device cannot reach ws://100.64.0.9:7787');
  expect(printed).toEqual([]);
});
