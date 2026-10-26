import { workspaceDisplayLabel, workspaceLabels } from '../workspace/display-label.ts';
import { makeConfig } from './_factories.ts';

const WORKTREES = '/Users/me/stim/.worktrees';

test('a single checkout keeps the short project name', () => {
  expect(workspaceLabels([{ root: '/Users/me/stim/apps/mobile' }]).get('/Users/me/stim/apps/mobile')).toBe('mobile');
});

test('same-named projects in different worktrees are told apart by their worktree directory', () => {
  const roots = [
    '/Users/me/stim/apps/mobile',
    `${WORKTREES}/qa-b-p2/apps/mobile`,
    `${WORKTREES}/qa-b-p3/apps/mobile`,
    '/Users/me/other/playground',
  ];
  const labels = workspaceLabels(roots.map((root) => ({ root })));
  expect(roots.map((root) => labels.get(root))).toEqual([
    'mobile (stim)',
    'mobile (qa-b-p2)',
    'mobile (qa-b-p3)',
    'playground',
  ]);
});

test('projects sharing a configured label are told apart by the first differing directory', () => {
  const labels = workspaceLabels([
    { root: `${WORKTREES}/a/app`, label: 'demo' },
    { root: `${WORKTREES}/b/app`, label: 'demo' },
  ]);
  expect([...labels.values()]).toEqual(['demo (a)', 'demo (b)']);
});

test('a workspace missing from the config is labelled against the registered ones', () => {
  const config = makeConfig({
    projects: {
      [`${WORKTREES}/qa-b-p2/apps/mobile`]: {},
      [`${WORKTREES}/qa-b-p3/apps/mobile`]: {},
    },
  });
  expect(workspaceDisplayLabel(`${WORKTREES}/qa-b-p4/apps/mobile`, config)).toBe('mobile (qa-b-p4)');
  expect(workspaceDisplayLabel('/Users/me/stim/apps/mobile', null)).toBe('mobile');
});
