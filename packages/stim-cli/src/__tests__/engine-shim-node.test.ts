import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { shimNodePath } from '../engine-store/promote.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function brew(): { prefix: string; keg: string } {
  const root = mkdtempSync(join(tmpdir(), 'stim-shim-'));
  dirs.push(root);
  const prefix = realpathSync(root);
  const kegDir = join(prefix, 'Cellar', 'node@22', '22.1.0');
  mkdirSync(join(kegDir, 'bin'), { recursive: true });
  writeFileSync(join(kegDir, 'bin', 'node'), '');
  mkdirSync(join(prefix, 'opt'));
  symlinkSync(kegDir, join(prefix, 'opt', 'node@22'));
  return { prefix, keg: join(kegDir, 'bin', 'node') };
}

describe('shimNodePath', () => {
  it.skipIf(process.platform === 'win32')('uses the Homebrew opt link of a keg Node', () => {
    const { prefix, keg } = brew();
    expect(shimNodePath(keg)).toBe(join(prefix, 'opt', 'node@22', 'bin', 'node'));
  });

  it.skipIf(process.platform === 'win32')('keeps a Node outside a keg, and a keg whose opt link is missing', () => {
    const { prefix, keg } = brew();
    const outside = mkdtempSync(join(tmpdir(), 'stim-shim-out-'));
    dirs.push(outside);
    const plain = join(outside, 'node');
    writeFileSync(plain, '');
    expect(shimNodePath(plain)).toBe(plain);
    expect(shimNodePath(join(outside, 'missing'))).toBe(join(outside, 'missing'));
    rmSync(join(prefix, 'opt', 'node@22'));
    expect(shimNodePath(keg)).toBe(keg);
  });
});
