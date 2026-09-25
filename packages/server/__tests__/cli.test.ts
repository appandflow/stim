import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPairingToken, spendPairingToken } from '../src/registry.ts';

const BIN = join(import.meta.dirname, '..', 'bin', 'stim-server.ts');

let home: string;

function run(...args: string[]): unknown {
  return JSON.parse(
    execFileSync(process.execPath, [BIN, ...args], {
      env: { ...process.env, STIM_HOME: home, PATH: '' },
      encoding: 'utf8',
    }),
  );
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-server-cli-'));
  process.env.STIM_HOME = home;
});

afterEach(() => {
  delete process.env.STIM_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe('--json', () => {
  it('pair prints the QR payload with its expiry', () => {
    const output = run('pair', '--json', '--port', '17787') as { qr: Record<string, unknown>; expiresAt: string };
    expect(Object.keys(output.qr).toSorted()).toEqual(['endpoint', 'name', 'pairingToken', 'v']);
    expect(output.qr.v).toBe(1);
    expect(Date.parse(output.expiresAt)).toBeGreaterThan(Date.now());
  });

  it('devices lists paired devices without their token hashes', () => {
    spendPairingToken(createPairingToken().token, 'Phone', { kind: 'local' });
    const { devices } = run('devices', '--json') as { devices: Record<string, unknown>[] };
    expect(devices).toHaveLength(1);
    expect(Object.keys(devices[0]!).toSorted()).toEqual([
      'capabilities',
      'id',
      'identity',
      'lastSeenAt',
      'name',
      'pairedAt',
    ]);
    expect(devices[0]!.name).toBe('Phone');
  });
});
