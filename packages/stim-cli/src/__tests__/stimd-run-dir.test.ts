import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDirRemoved } from '../stimd/run-dir.ts';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-test-'));
});

afterEach(() => {
  chmodSync(home, 0o700);
  rmSync(home, { recursive: true, force: true });
});

describe('a stimd deciding whether its run directory was removed', () => {
  test('a missing run directory in a home that still holds Stim state is removed', () => {
    mkdirSync(join(home, 'daemon'));
    expect(runDirRemoved(join(home, 'run'))).toBe(true);
  });

  test('a present run directory is not removed', () => {
    mkdirSync(join(home, 'run'));
    mkdirSync(join(home, 'daemon'));
    expect(runDirRemoved(join(home, 'run'))).toBe(false);
  });

  test('a missing home is not taken as removed', () => {
    expect(runDirRemoved(join(home, 'gone', 'run'))).toBe(false);
  });

  test('an empty home, as an unmounted mount point leaves, is not taken as removed', () => {
    expect(runDirRemoved(join(home, 'run'))).toBe(false);
  });

  test('a dangling run symlink is not taken as removed', () => {
    mkdirSync(join(home, 'daemon'));
    symlinkSync(join(home, 'elsewhere'), join(home, 'run'));
    expect(runDirRemoved(join(home, 'run'))).toBe(false);
  });

  test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'an error other than ENOENT on the run directory is not taken as removed',
    () => {
      mkdirSync(join(home, 'daemon'));
      chmodSync(home, 0o000);
      expect(runDirRemoved(join(home, 'run'))).toBe(false);
    },
  );
});
