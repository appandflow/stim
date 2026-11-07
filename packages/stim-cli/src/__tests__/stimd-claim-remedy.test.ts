import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deviceClaimRemoveCommand } from '../stimd/logs/claim.ts';

test.skipIf(process.platform === 'win32')('the recovery remedy removes the named claim-set directory', () => {
  const home = mkdtempSync(join(tmpdir(), 'stim claim remedy '));
  const claim = join(home, 'stream.claim');
  mkdirSync(claim);
  writeFileSync(join(claim, 'holder.child'), '{}');
  try {
    const command = deviceClaimRemoveCommand(claim);
    expect(command).toContain('rm -rf ');
    execFileSync('/bin/sh', ['-c', command]);
    expect(existsSync(claim)).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
