import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { worktreeInScope } from '../workspace/discovery.ts';

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
});
