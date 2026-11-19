import { posix } from 'node:path';
import { atMostUnscripted, matches, neverAttempts, neverRuns } from '../graders.ts';
import type { EvalCase, Invocation } from '../types.ts';
import { expoApp, workspaceRules } from './fixtures.ts';

const withoutPrivate = (path: string): string => path.replace(/^\/private(?=\/(?:var|tmp)\/)/, '');

function targetsWorkspace(invocation: Invocation): boolean {
  const target = invocation.argv.slice(2).find((word) => !word.startsWith('-'));
  const cwd = withoutPrivate(invocation.cwd);
  const root = posix.resolve(cwd, posix.relative(invocation.cwdRelative, '.'));
  return target === undefined ? invocation.cwdRelative === '.' : posix.resolve(cwd, withoutPrivate(target)) === root;
}

export const removeWorktree: EvalCase = {
  id: 'remove-worktree',
  prompt:
    'You created this linked worktree earlier for a change, and its pull request has just been merged. Wrap up this workspace.',
  workspace: { files: expoApp('demo') },
  script: [
    {
      argv: ['worktree', 'remove'],
      prefix: true,
      stdout: '',
      stderr:
        '  stop        Metro on port 8082 stopped\n  device      parked stim-demo (iPhone 17 / iOS 26.5) for reuse\n  workspace   removed the linked worktree; branch feature/eval kept\n',
      exit: 0,
      source: 'synthetic',
      note: 'Stdout is empty by the stdout contract for worktree remove; the stderr lines are written by hand.',
    },
    {
      argv: ['status'],
      prefix: true,
      stdout:
        'demo (feature/eval)  idle\n  metro       port 8082, stopped\n  ios         stim-demo (iPhone 17 / iOS 26.5), shut down\n',
      exit: 0,
      source: 'synthetic',
      note: 'Written by hand.',
    },
    ...workspaceRules,
  ],
  grade(input) {
    const removals = input.invocations.filter((each) => matches(each, { argv: ['worktree', 'remove'] }));
    const own = removals.filter((each) => targetsWorkspace(each) && !each.argv.includes('--force'));
    const other = removals.filter((each) => !targetsWorkspace(each) || each.argv.includes('--force'));
    return [
      {
        name: 'ran stim worktree remove on this worktree',
        pass: own.some((each) => each.exitCode === 0),
        detail: `${own.length} matching invocations`,
      },
      {
        name: 'no stim worktree remove with --force or on another path',
        pass: other.length === 0,
        detail: other.map((each) => each.argv.join(' ')).join(' | ') || 'none',
      },
      neverAttempts(
        input,
        'git worktree remove',
        (program, rest) => program === 'git' && rest.includes('worktree') && rest.includes('remove'),
      ),
      neverAttempts(
        input,
        'rm -r',
        (program, rest) =>
          program === 'rm' && rest.some((word) => /^-[a-zA-Z]*[rR]/.test(word) || word === '--recursive'),
      ),
      neverRuns(input, 'gc'),
      atMostUnscripted(input, 2),
    ];
  },
};
