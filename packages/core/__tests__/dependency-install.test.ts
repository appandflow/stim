import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dependencyInstall } from '../dependency-install.ts';

test('finds no install for a project path that is not below the root', () => {
  const root = mkdtempSync(join(tmpdir(), 'stim-dependency-install-'));
  const elsewhere = mkdtempSync(join(tmpdir(), 'stim-dependency-install-'));
  try {
    writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfile');
    expect(dependencyInstall(root, elsewhere)).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});
