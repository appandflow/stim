import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkoutRootsCacheFile } from '@stim-cli/core/state';
import { verifiedCheckoutRoots } from '../checkout-roots.ts';
import { repoRootAsync } from '../workspace/worktree.ts';

describe('verifiedCheckoutRoots', () => {
  let base: string;
  let asked: string[];
  const rootOf = (path: string) => {
    asked.push(path);
    return repoRootAsync(path);
  };
  const init = (path: string) => {
    mkdirSync(path, { recursive: true });
    execFileSync('git', ['-C', path, 'init', '-q']);
  };

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'stim-checkout-roots-')));
    process.env.STIM_HOME = join(base, 'home');
    asked = [];
  });

  afterEach(() => {
    delete process.env.STIM_HOME;
    rmSync(base, { recursive: true, force: true });
  });

  it('asks Git once for an unchanged checkout and again for a re-created one', async () => {
    const repo = join(base, 'repo');
    init(repo);
    expect(await verifiedCheckoutRoots([repo], rootOf)).toEqual(new Set([repo]));
    expect(await verifiedCheckoutRoots([repo], rootOf)).toEqual(new Set([repo]));
    expect(asked).toEqual([repo]);

    rmSync(join(repo, '.git'), { recursive: true });
    expect(await verifiedCheckoutRoots([repo], rootOf)).toEqual(new Set());
    init(repo);
    expect(await verifiedCheckoutRoots([repo], rootOf)).toEqual(new Set([repo]));
    expect(asked).toEqual([repo, repo, repo]);
  });

  it('asks Git again when the .git entry changes while it still exists', async () => {
    const repo = join(base, 'repo');
    init(repo);
    await verifiedCheckoutRoots([repo], rootOf);
    writeFileSync(join(repo, '.git', 'touched'), '');
    expect(await verifiedCheckoutRoots([repo], rootOf)).toEqual(new Set([repo]));
    expect(asked).toEqual([repo, repo]);
  });

  it('asks Git every time about a path it does not confirm as a repository root', async () => {
    const outer = join(base, 'outer');
    init(outer);
    const inner = join(outer, 'inner');
    mkdirSync(join(inner, '.git'), { recursive: true });
    expect(await verifiedCheckoutRoots([inner], rootOf)).toEqual(new Set());
    expect(await verifiedCheckoutRoots([inner], rootOf)).toEqual(new Set());
    expect(asked).toEqual([inner, inner]);
  });

  it('treats an unreadable cache as empty and replaces it', async () => {
    const repo = join(base, 'repo');
    init(repo);
    mkdirSync(join(base, 'home'), { recursive: true });
    writeFileSync(checkoutRootsCacheFile(), '{"schema":1,"checkouts":');
    expect(await verifiedCheckoutRoots([repo], rootOf)).toEqual(new Set([repo]));
    expect(asked).toEqual([repo]);
    expect(JSON.parse(readFileSync(checkoutRootsCacheFile(), 'utf-8')).checkouts).toHaveProperty([repo]);
    await verifiedCheckoutRoots([repo], rootOf);
    expect(asked).toEqual([repo]);
  });
});
