import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Command } from 'commander';
import { releaseClaim, tryAcquireClaim, type ClaimHandle } from '@stim-cli/core/ownership-claim';
import { stimdClaimRoot, stimdRunDir, stimdSocket } from '@stim-cli/core/state';

let home: string;
let server: Server | null = null;
const connections = new Set<Socket>();
let claim: ClaimHandle | null = null;
let errors: string[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-pair-command-'));
  process.env.STIM_HOME = home;
  errors = [];
  vi.spyOn(console, 'error').mockImplementation((line: unknown) => void errors.push(String(line)));
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  for (const connection of connections) connection.destroy();
  connections.clear();
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
  const { default: pairCommand } = await import('../commands/pair.ts');
  const program = new Command().exitOverride();
  pairCommand(program);
  await program.parseAsync(['node', 'stim', 'pair', '--control']);
}

test('a stimd of another Stim build is named, not reported as missing', async () => {
  const socket = stimdSocket();
  mkdirSync(dirname(socket), { recursive: true, mode: 0o700 });
  mkdirSync(stimdRunDir(), { recursive: true, mode: 0o700 });
  claim = tryAcquireClaim({ root: stimdClaimRoot(), mode: 'exclusive', label: 'test stimd' }).acquired ?? null;
  server = createServer((connection) => {
    connections.add(connection);
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
