import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stimBuildDigest } from '@stim-cli/core/state';
import { packWorkspace, publishedRange, workspacePackages } from '../src/machine-update.ts';

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
