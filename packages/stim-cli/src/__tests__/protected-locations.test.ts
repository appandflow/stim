import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isProtectedLocation } from '../workspace/protected-locations.ts';

describe('isProtectedLocation', () => {
  let base: string;
  let roots: { home: string; temps: string[] };

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'stim-protected-')));
    roots = { home: join(base, 'home'), temps: [join(base, 'scratch')] };
    for (const dir of ['home/.codex/work', 'home/Developer/app', 'scratch/run', 'elsewhere'])
      mkdirSync(join(base, dir), { recursive: true });
  });

  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('protects temp roots and home dot-folders, and fails closed for a path that does not resolve', () => {
    expect(isProtectedLocation(join(base, 'scratch', 'run'), roots)).toBe(true);
    expect(isProtectedLocation(join(base, 'home', '.codex', 'work'), roots)).toBe(true);
    expect(isProtectedLocation(join(base, 'home', 'Developer', 'app'), roots)).toBe(false);
    expect(isProtectedLocation(join(base, 'elsewhere'), roots)).toBe(false);
    expect(isProtectedLocation(join(base, 'home', 'Developer', 'missing'), roots)).toBe(true);
  });

  it('follows a symlink into a home dot-folder', () => {
    symlinkSync(join(base, 'home', '.codex', 'work'), join(base, 'elsewhere', 'link'));
    expect(isProtectedLocation(join(base, 'elsewhere', 'link'), roots)).toBe(true);
  });

  it('sees /private/tmp as the temp directory /tmp names where both exist', () => {
    if (!existsSync('/private/tmp')) return;
    expect(isProtectedLocation('/private/tmp', { home: roots.home, temps: ['/tmp'] })).toBe(true);
  });
});
