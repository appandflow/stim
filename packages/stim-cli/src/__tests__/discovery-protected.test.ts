import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Config } from '@stim-cli/core/state';
import { discoverCheckouts, worktreeInScope } from '../workspace/discovery.ts';

describe('a protected location and maintenance.discoverRoots, with the real protection rule', () => {
  let base: string;

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'stim-discovery-protected-')));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(base, { recursive: true, force: true });
  });

  it('acts on a linked worktree under the temporary directory only inside a discover root', () => {
    const roots = join(base, 'roots');
    mkdirSync(join(roots, 'wt'), { recursive: true });
    mkdirSync(join(base, 'other', 'wt'), { recursive: true });
    const where = { main: join(base, 'main'), folders: [base] };
    expect(worktreeInScope(join(roots, 'wt'), { ...where, roots: [roots] })).toBe(true);
    expect(worktreeInScope(join(roots, 'wt'), { ...where, roots: [] })).toBe(false);
    expect(worktreeInScope(join(base, 'other', 'wt'), { ...where, roots: [roots] })).toBe(false);
  });

  it('lists a recognised child of a discover root under the temporary directory', async () => {
    vi.stubEnv('STIM_HOME', join(base, 'home'));
    const roots = join(base, 'roots');
    mkdirSync(join(roots, 'app'), { recursive: true });
    writeFileSync(join(roots, 'app', 'package.json'), JSON.stringify({ dependencies: { expo: '*' } }));
    const config: Config = { maintenance: { discoverRoots: [roots] }, projects: {}, repos: {} };
    expect((await discoverCheckouts(config, [])).map(({ path }) => path)).toEqual([join(roots, 'app')]);
  });
});
