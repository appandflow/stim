import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inToolFolder, worktreeInScope } from '../workspace/discovery.ts';
import { isProtectedLocation } from '../workspace/protected-locations.ts';

describe('a protected location and maintenance.discoverRoots, with the real protection rule', () => {
  let base: string;

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'stim-discovery-protected-')));
  });

  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('acts on a linked worktree under the temporary directory only inside a discover root', () => {
    const roots = join(base, 'roots');
    mkdirSync(join(roots, 'wt'), { recursive: true });
    mkdirSync(join(base, 'other', 'wt'), { recursive: true });
    const where = { main: join(base, 'main'), folders: [base] };
    expect(worktreeInScope(join(roots, 'wt'), { ...where, roots: [roots] })).toBe(true);
    expect(worktreeInScope(join(roots, 'wt'), { ...where, roots: [] })).toBe(false);
    expect(worktreeInScope(join(base, 'other', 'wt'), { ...where, roots: [roots] })).toBe(false);
  });

  it('protects every home dot-folder, yet names only ~/.codex/worktrees as a tool folder', () => {
    const home = join(base, 'home');
    for (const dir of ['.codex/worktrees/a/app', '.codex/sessions/a', '.claude/worktrees/a', 'dev/a'])
      mkdirSync(join(home, dir), { recursive: true });
    const roots = { home, temps: [] };
    expect(isProtectedLocation(join(home, '.codex', 'worktrees', 'a', 'app'), roots)).toBe(true);
    expect(isProtectedLocation(join(home, 'dev', 'a'), roots)).toBe(false);
    expect(inToolFolder(join(home, '.codex', 'worktrees', 'a', 'app'), home)).toBe(true);
    expect(inToolFolder(join(home, '.codex', 'sessions', 'a'), home)).toBe(false);
    expect(inToolFolder(join(home, '.claude', 'worktrees', 'a'), home)).toBe(false);
    expect(inToolFolder(join(home, 'dev', 'a'), home)).toBe(false);
  });
});
