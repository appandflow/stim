import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { packWorkspace, workspacePackages } from '../src/machine-update.ts';
import { installServer } from '../src/service.ts';

const UNPUBLISHED = '99.0.0';
const SERVER_DIR = fileURLToPath(new URL('..', import.meta.url));

let root: string;

async function packAtUnpublishedVersion(out: string): Promise<void> {
  const packages = workspacePackages(SERVER_DIR);
  if (!packages) throw new Error('This test runs from a Stim checkout.');
  const names = new Set(packages.keys());
  for (const file of await packWorkspace(packages)) {
    const work = mkdtempSync(join(root, 'pack-'));
    const tarball = join(work, file.name);
    writeFileSync(tarball, file.bytes);
    execFileSync('/usr/bin/tar', ['-xzf', tarball, '-C', work]);
    const manifestPath = join(work, 'package', 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    manifest.version = UNPUBLISHED;
    for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
      const ranges = manifest[field] as Record<string, string> | undefined;
      for (const [name, range] of Object.entries(ranges ?? {})) {
        if (names.has(name)) ranges![name] = range.startsWith('^') ? `^${UNPUBLISHED}` : UNPUBLISHED;
      }
    }
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    execFileSync('/usr/bin/tar', ['-czf', join(out, file.name), '-C', work, 'package'], {
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    });
  }
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'stim-install-from-'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('stim-server service update --from against real npm', () => {
  it('installs packed Stim packages at an unpublished version and still audits registry packages', async () => {
    const from = join(root, 'incoming');
    const versions = join(root, 'versions');
    mkdirSync(from);
    await packAtUnpublishedVersion(from);

    const installed = await installServer(versions, { from }, process.execPath, () => {});
    expect(installed.build.version).toBe(UNPUBLISHED);

    const audit = JSON.parse(
      execFileSync('npm', ['audit', 'signatures', '--json', '--prefix', installed.dir], { encoding: 'utf8' }),
    ) as { invalid: unknown[]; missing: unknown[] };
    expect(audit).toEqual({ invalid: [], missing: [] });

    const lock = JSON.parse(readFileSync(join(installed.dir, 'package-lock.json'), 'utf8')) as {
      packages: Record<string, { resolved?: string }>;
    };
    const fromRegistry = Object.values(lock.packages).filter((entry) => entry.resolved?.startsWith('https://'));
    expect(fromRegistry.length).toBeGreaterThan(0);
    const report = execFileSync('npm', ['audit', 'signatures', '--prefix', installed.dir], { encoding: 'utf8' });
    expect(report).toContain(`${fromRegistry.length} packages have verified registry signatures`);
  }, 300_000);
});
