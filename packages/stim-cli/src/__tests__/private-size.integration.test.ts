import { randomBytes } from 'node:crypto';
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { measureTree } from '../private-size.ts';

let scratch: string;

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'stim-private-size-')));
  vi.stubEnv('STIM_HOME', join(scratch, 'home'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(scratch, { recursive: true, force: true });
});

const allocated = (file: string) => statSync(file).blocks * 512;

describe.skipIf(process.platform !== 'darwin')('measureTree with the stim-privsize helper', () => {
  test('counts a clone and a link from outside as shared, and a copy once however many links it has inside', async () => {
    const source = join(scratch, 'source');
    const tree = join(scratch, 'tree');
    mkdirSync(source);
    mkdirSync(join(tree, 'nested'), { recursive: true });
    writeFileSync(join(source, 'cloned'), randomBytes(3 * 1024 * 1024));
    writeFileSync(join(source, 'linked'), randomBytes(1024 * 1024));
    execFileSync('cp', ['-c', join(source, 'cloned'), join(tree, 'clone')]);
    execFileSync('cp', [join(source, 'cloned'), join(tree, 'copy')]);
    linkSync(join(tree, 'copy'), join(tree, 'nested', 'copy-link'));
    linkSync(join(source, 'linked'), join(tree, 'from-store'));
    symlinkSync(source, join(tree, 'outside'));

    const size = await measureTree(tree, { timeoutMs: 60_000 });

    const copy = allocated(join(tree, 'copy'));
    expect(size).toEqual({
      bytes: allocated(join(tree, 'clone')) + copy + allocated(join(tree, 'from-store')),
      privateBytes: copy,
    });
  }, 120_000);
});
