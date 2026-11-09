import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fingerprintSyncFiles } from '../fingerprint/replay.ts';
import { sourceManifest } from '../offload/native-source.ts';
import { iosSyncPlan } from '../offload/signing-files.ts';
import type { Input } from '../fingerprint/key.ts';

test('explicit keyed ignored files transfer while existence and directory probes transfer no contents', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-fingerprint-sync-')));
  try {
    execFileSync('git', ['init', '--quiet', root]);
    writeFileSync(join(root, '.gitignore'), 'private/\n');
    mkdirSync(join(root, 'private'));
    writeFileSync(join(root, 'private', 'keyed.txt'), 'keyed');
    writeFileSync(join(root, 'private', 'probe.txt'), 'not keyed');
    writeFileSync(join(root, 'private', 'signing.p12'), 'private signing key');
    const row = (name: string): Input => ({ name, kind: 'file', hash: '0'.repeat(64) });
    const files = fingerprintSyncFiles(root, [
      row('private/keyed.txt'),
      row('private/signing.p12'),
      row('exists:private/probe.txt'),
      row('dir:private'),
    ]);
    if (!Array.isArray(files)) throw new Error(files.uncertain);
    expect(files).toEqual([join(root, 'private', 'keyed.txt'), join(root, 'private', 'signing.p12')]);
    const manifest = await sourceManifest(
      root,
      true,
      undefined,
      files.map((file) => relative(root, file)),
    );
    const plan = await iosSyncPlan(
      root,
      manifest.map((file) => file.path),
    );
    const paths = manifest.filter((file) => !plan.omit.has(file.path)).map((file) => file.path);
    expect(paths).toContain('private/keyed.txt');
    expect(paths).not.toContain('private/probe.txt');
    expect(paths).not.toContain('private/signing.p12');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === 'win32')(
  'an explicit input cannot transfer through a symlink outside the repository',
  () => {
    const area = realpathSync(mkdtempSync(join(tmpdir(), 'stim-fingerprint-boundary-')));
    const root = join(area, 'repo');
    try {
      mkdirSync(root);
      mkdirSync(join(area, 'outside'));
      writeFileSync(join(area, 'outside', 'secret'), 'private');
      execFileSync('git', ['init', '--quiet', root]);
      symlinkSync(join(area, 'outside'), join(root, 'linked'));
      expect(fingerprintSyncFiles(root, [{ name: 'linked/secret', kind: 'file', hash: '0'.repeat(64) }])).toMatchObject(
        { uncertain: expect.stringContaining('outside the repository') },
      );
    } finally {
      rmSync(area, { recursive: true, force: true });
    }
  },
);
