import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

test('changes the marker identity when the major of the pinned Node the worker installs with changes', () => {
  const root = mkdtempSync(join(tmpdir(), 'stim-dependency-install-'));
  const nvm = join(root, 'nvm');
  const install = (version: string) => {
    mkdirSync(join(nvm, 'versions', 'node', version, 'bin'), { recursive: true });
    writeFileSync(join(nvm, 'versions', 'node', version, 'bin', 'node'), '');
  };
  const digest = () => dependencyInstall(root, 'mobile', 'apps/mobile', { NVM_DIR: nvm })?.digest;
  try {
    mkdirSync(join(root, 'apps', 'mobile'), { recursive: true });
    writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfile');
    const unpinned = digest();
    writeFileSync(join(root, '.nvmrc'), '1\n');
    install('v1.3.0');
    const one = digest();
    install('v1.4.0');
    expect(digest()).toBe(one);
    writeFileSync(join(root, '.nvmrc'), '2\n');
    install('v2.0.0');
    expect(new Set([unpinned, one, digest()]).size).toBe(3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
