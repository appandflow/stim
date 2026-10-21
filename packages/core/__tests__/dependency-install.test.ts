import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, normalize } from 'node:path';
import { dependencyInstall, reusableDependencies } from '../dependency-install.ts';

test.each([
  ['pnpm-lock.yaml', 'pnpm', ['install', '--frozen-lockfile']],
  ['yarn.lock', 'yarn', ['install', '--frozen-lockfile']],
  ['package-lock.json', 'npm', ['ci']],
] as const)('installs the whole workspace of a member app with %s', (file, command, args) => {
  const root = mkdtempSync(join(tmpdir(), 'stim-dependency-install-'));
  try {
    mkdirSync(join(root, 'apps', 'mobile'), { recursive: true });
    writeFileSync(join(root, 'apps', 'mobile', 'package.json'), JSON.stringify({ name: 'mobile' }));
    writeFileSync(join(root, file), 'lockfile');
    expect(dependencyInstall(root, 'apps/mobile')).toMatchObject({ command, args, dir: '.' });
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
  const digest = () => dependencyInstall(root, 'apps/mobile', { NVM_DIR: nvm })?.digest;
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

test.each([
  ['a workspace member', { 'pnpm-lock.yaml': 'root' }, 'pnpm-lock.yaml', 'pnpm', '.'],
  [
    'a standalone app inside a workspace root',
    { 'package-lock.json': 'root', 'apps/mobile/package-lock.json': 'app' },
    'apps/mobile/package-lock.json',
    'npm',
    'apps/mobile',
  ],
  ['a nested workspace', { 'apps/yarn.lock': 'apps' }, 'apps/yarn.lock', 'yarn', 'apps'],
] as const)('installs %s with the nearest lockfile at or above it', (_, files, lock, command, dir) => {
  const root = mkdtempSync(join(tmpdir(), 'stim-dependency-install-'));
  try {
    mkdirSync(join(root, 'apps', 'mobile'), { recursive: true });
    for (const [file, text] of Object.entries(files)) writeFileSync(join(root, file), text);
    const lockfile = createHash('sha256')
      .update(readFileSync(join(root, lock)))
      .digest('hex');
    const install = dependencyInstall(root, 'apps/mobile');
    expect(install).toMatchObject({ command, dir: normalize(dir), lockfile });
    expect(install?.marker === 'dependencies').toBe(dir === '.');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.each([
  ['package-lock.json', 'hoisted to the workspace root', true],
  ['yarn.lock', 'hoisted to the workspace root', true],
  ['package-lock.json', 'missing everywhere', false],
] as const)('reuses a %s install %s by where the install ran', (file, _, installed) => {
  const area = mkdtempSync(join(tmpdir(), 'stim-dependency-install-'));
  try {
    const src = join(area, 'src');
    mkdirSync(join(src, 'apps', 'mobile'), { recursive: true });
    writeFileSync(join(src, file), 'lockfile');
    const install = dependencyInstall(src, 'apps/mobile');
    if (!install) throw new Error('expected an install');
    writeFileSync(join(area, install.marker), install.digest);
    if (installed) mkdirSync(join(src, 'node_modules'));
    expect(reusableDependencies(area, 'apps/mobile', install.lockfile)).toBe(installed);
  } finally {
    rmSync(area, { recursive: true, force: true });
  }
});
