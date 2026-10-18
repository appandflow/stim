import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dependencyInstall } from '../dependency-install.ts';

test.each([
  ['pnpm-lock.yaml', 'mobile', 'pnpm', ['install', '--frozen-lockfile', '--filter', 'mobile...']],
  ['pnpm-lock.yaml', null, 'pnpm', ['install', '--frozen-lockfile']],
  ['yarn.lock', 'mobile', 'yarn', ['install', '--frozen-lockfile']],
  ['package-lock.json', 'mobile', 'npm', ['ci']],
] as const)('preserves the worker install invocation for %s and package %s', (file, name, command, args) => {
  const root = mkdtempSync(join(tmpdir(), 'stim-dependency-install-'));
  try {
    writeFileSync(join(root, file), 'lockfile');
    expect(dependencyInstall(root, name)).toMatchObject({ command, args });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
